"""Company gateway (pooled Daraja collection + settlement) schema and helpers.

Phase 3 collection flow: a pooled STK push inserts a gateway_payments row
(status initiated) next to the existing pppoe_stk_requests/hotspot_purchases
row. Whoever verifies the payment first — the portal /pay/status poll, the
/api/daraja/<secret>/stk callback, or the stale-payment sweep — runs
confirm_collection inside the same transaction as the subscriber credit, so
the ledger entry and pppoe_store.renew each happen exactly once.

Tables created here follow the same convention as api.ensure_schema():
CREATE TABLE IF NOT EXISTS plus SHOW COLUMNS / ALTER for additive changes,
so every start is idempotent. Rollback is manual — UNDO_STATEMENTS mirrors
database/GATEWAY_ROLLBACK.md and is exercised by test_gateway_db.py.

Money is DECIMAL(12,2) KES everywhere. The ledger is append-only: two
triggers reject UPDATE and DELETE on gateway_ledger_entries, so a wrong
entry is corrected by a new reversal row, never edited.

Exactly-once anchors:
  gateway_payments.mpesa_receipt UNIQUE, .checkout_id UNIQUE
  gateway_ledger_entries (payment_id, type) / (payout_id, type) UNIQUE
  gateway_payouts.idempotency_key UNIQUE (+ Daraja conversation ids, receipt)
A callback and the /pay/status poll may race; the collection ledger insert
and the pppoe_store.renew call are claimed under SELECT ... FOR UPDATE and
the unique keys above make a second attempt fail instead of double-crediting.
"""

import hashlib
import json
import os
import secrets
import uuid
from decimal import Decimal, ROUND_HALF_UP

import pymysql

COMPANY_ID = "company"

# Mirrors database/GATEWAY_ROLLBACK.md — keep both in sync.
UNDO_STATEMENTS = [
    "DROP TRIGGER IF EXISTS gw_ledger_no_update",
    "DROP TRIGGER IF EXISTS gw_ledger_no_delete",
    "DROP TABLE IF EXISTS settlement_batch_entries",
    "DROP TABLE IF EXISTS gateway_ledger_entries",
    "DROP TABLE IF EXISTS gateway_payouts",
    "DROP TABLE IF EXISTS settlement_batches",
    "DROP TABLE IF EXISTS gateway_payments",
    "DROP TABLE IF EXISTS gateway_callback_events",
    "DROP TABLE IF EXISTS gateway_audit_log",
    "DROP TABLE IF EXISTS gateway_notifications",
    "DROP TABLE IF EXISTS gateway_fee_bands",
    "ALTER TABLE isp_payout_settings MODIFY COLUMN settlement_mode ENUM('immediate','delayed') NOT NULL DEFAULT 'immediate'",
    "ALTER TABLE isp_payout_settings DROP COLUMN settle_every_n_tx",
    "ALTER TABLE isp_payout_settings DROP COLUMN settle_schedule",
    "ALTER TABLE isp_payout_settings DROP COLUMN last_settled_at",
    "DROP TABLE IF EXISTS isp_payout_settings",
    "ALTER TABLE company_daraja_settings DROP COLUMN callback_secret_enc",
    "ALTER TABLE company_daraja_settings DROP COLUMN initiator_name",
    "ALTER TABLE company_daraja_settings DROP COLUMN initiator_password_enc",
    "ALTER TABLE company_daraja_settings DROP COLUMN payout_shortcode",
    "ALTER TABLE company_daraja_settings DROP COLUMN status",
    "ALTER TABLE company_daraja_settings DROP COLUMN commission_percent",
    "ALTER TABLE company_daraja_settings DROP COLUMN commission_flat",
    "ALTER TABLE company_daraja_settings DROP COLUMN default_hold_hours",
    "ALTER TABLE company_daraja_settings DROP COLUMN min_payout",
    "ALTER TABLE company_daraja_settings DROP COLUMN max_payout_per_tx",
    "ALTER TABLE company_daraja_settings DROP COLUMN kill_switch",
    "ALTER TABLE company_daraja_settings DROP COLUMN last_verified_at",
    "ALTER TABLE company_daraja_settings DROP COLUMN payout_fee_estimate",
    "ALTER TABLE company_daraja_settings DROP COLUMN last_known_balance",
    "ALTER TABLE company_daraja_settings DROP COLUMN last_balance_at",
    "ALTER TABLE company_daraja_settings DROP COLUMN txn_fees_enabled",
    "ALTER TABLE company_daraja_settings DROP COLUMN public_base",
]


def ensure_schema(cursor):
    # --- company_daraja_settings: gateway columns added alongside the
    # existing collection credentials (nullable or defaulted, so existing
    # readers and INSERT...SELECT readers keep working).
    for column, definition in (
        ("callback_secret_enc", "callback_secret_enc VARCHAR(512) NULL"),
        ("initiator_name", "initiator_name VARCHAR(128) NOT NULL DEFAULT ''"),
        ("initiator_password_enc", "initiator_password_enc VARCHAR(512) NULL"),
        ("payout_shortcode", "payout_shortcode VARCHAR(10) NOT NULL DEFAULT ''"),
        ("status", "status ENUM('draft','verified','active','suspended') NOT NULL DEFAULT 'draft'"),
        ("commission_percent", "commission_percent DECIMAL(5,2) NOT NULL DEFAULT 0"),
        ("commission_flat", "commission_flat DECIMAL(12,2) NOT NULL DEFAULT 0"),
        ("default_hold_hours", "default_hold_hours INT NOT NULL DEFAULT 24"),
        ("min_payout", "min_payout DECIMAL(12,2) NOT NULL DEFAULT 0"),
        ("max_payout_per_tx", "max_payout_per_tx DECIMAL(12,2) NOT NULL DEFAULT 0"),
        ("kill_switch", "kill_switch TINYINT NOT NULL DEFAULT 0"),
        ("last_verified_at", "last_verified_at DATETIME NULL"),
        ("payout_fee_estimate", "payout_fee_estimate DECIMAL(12,2) NOT NULL DEFAULT 0"),
        ("last_known_balance", "last_known_balance DECIMAL(14,2) NULL"),
        ("last_balance_at", "last_balance_at DATETIME NULL"),
        ("txn_fees_enabled", "txn_fees_enabled TINYINT NOT NULL DEFAULT 0"),
        ("public_base", "public_base VARCHAR(255) NOT NULL DEFAULT ''"),
    ):
        cursor.execute("SHOW COLUMNS FROM company_daraja_settings LIKE %s", (column,))
        if cursor.fetchone() is None:
            cursor.execute(f"ALTER TABLE company_daraja_settings ADD COLUMN {definition}")

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS isp_payout_settings (
          client_id CHAR(36) NOT NULL PRIMARY KEY,
          company_id VARCHAR(36) NOT NULL DEFAULT 'company',
          gateway_mode ENUM('company_gateway', 'own_daraja', 'none') NOT NULL DEFAULT 'none',
          settlement_mode ENUM('immediate', 'delayed') NOT NULL DEFAULT 'immediate',
          hold_hours INT NOT NULL DEFAULT 24,
          destination_type ENUM('phone', 'paybill', 'till') NULL,
          destination_value VARCHAR(32) NOT NULL DEFAULT '',
          account_reference VARCHAR(32) NOT NULL DEFAULT '',
          min_payout_override DECIMAL(12,2) NULL,
          pending_change TEXT NULL,
          pending_change_effective_at DATETIME NULL,
          updated_by VARCHAR(40) NOT NULL DEFAULT '',
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          KEY idx_payout_company (company_id, gateway_mode)
        )
        """
    )

    for column, definition in (
        ("settle_every_n_tx", "settle_every_n_tx INT NULL"),
        ("settle_schedule", "settle_schedule TEXT NULL"),
        ("last_settled_at", "last_settled_at DATETIME NULL"),
    ):
        cursor.execute("SHOW COLUMNS FROM isp_payout_settings LIKE %s", (column,))
        if cursor.fetchone() is None:
            cursor.execute(f"ALTER TABLE isp_payout_settings ADD COLUMN {definition}")

    cursor.execute("SHOW COLUMNS FROM isp_payout_settings LIKE 'settlement_mode'")
    column = cursor.fetchone() or {}
    if "transactions" not in str(column.get("Type") or ""):
        cursor.execute(
            "ALTER TABLE isp_payout_settings MODIFY COLUMN settlement_mode "
            "ENUM('immediate','delayed','transactions','scheduled') NOT NULL DEFAULT 'immediate'"
        )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS gateway_payments (
          id CHAR(36) NOT NULL PRIMARY KEY,
          company_id VARCHAR(36) NOT NULL DEFAULT 'company',
          client_id CHAR(36) NULL,
          source ENUM('pppoe', 'hotspot', 'manual') NOT NULL DEFAULT 'pppoe',
          subscriber_id CHAR(36) NULL,
          hotspot_purchase_id CHAR(36) NULL,
          invoice_id CHAR(36) NULL,
          channel ENUM('stk', 'c2b') NOT NULL,
          msisdn VARCHAR(20) NOT NULL DEFAULT '',
          amount DECIMAL(12,2) NOT NULL,
          mpesa_receipt VARCHAR(40) NULL,
          checkout_id VARCHAR(64) NULL,
          account_reference VARCHAR(40) NOT NULL DEFAULT '',
          status ENUM('initiated', 'confirmed', 'failed', 'cancelled', 'unmatched') NOT NULL DEFAULT 'initiated',
          confirmed_at DATETIME NULL,
          raw_callback MEDIUMTEXT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_gw_pay_receipt (mpesa_receipt),
          UNIQUE KEY uq_gw_pay_checkout (checkout_id),
          KEY idx_gw_pay_client (client_id, status, confirmed_at),
          KEY idx_gw_pay_company (company_id, status)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS settlement_batches (
          id CHAR(36) NOT NULL PRIMARY KEY,
          company_id VARCHAR(36) NOT NULL DEFAULT 'company',
          client_id CHAR(36) NOT NULL,
          batch_key VARCHAR(80) NOT NULL,
          period_from DATETIME NOT NULL,
          period_to DATETIME NOT NULL,
          gross DECIMAL(12,2) NOT NULL DEFAULT 0,
          commission DECIMAL(12,2) NOT NULL DEFAULT 0,
          payout_fee DECIMAL(12,2) NOT NULL DEFAULT 0,
          net DECIMAL(12,2) NOT NULL DEFAULT 0,
          status ENUM('scheduled', 'processing', 'paid', 'partially_paid', 'failed') NOT NULL DEFAULT 'scheduled',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_gw_batch_key (batch_key),
          KEY idx_gw_batch_client (client_id, status)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS gateway_ledger_entries (
          id CHAR(36) NOT NULL PRIMARY KEY,
          seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
          company_id VARCHAR(36) NOT NULL DEFAULT 'company',
          client_id CHAR(36) NOT NULL,
          payment_id CHAR(36) NULL,
          payout_id CHAR(36) NULL,
          type ENUM('collection', 'commission', 'payout_fee', 'payout', 'reversal', 'adjustment') NOT NULL,
          amount DECIMAL(12,2) NOT NULL,
          balance_after DECIMAL(12,2) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_gw_ledger_payment (payment_id, type),
          UNIQUE KEY uq_gw_ledger_payout (payout_id, type),
          KEY idx_gw_ledger_client (client_id, created_at),
          KEY idx_gw_ledger_company (company_id, created_at)
        )
        """
    )

    # The ledger orders by seq, not created_at — TIMESTAMP has second
    # precision and several entries land in the same second.
    cursor.execute("SHOW COLUMNS FROM gateway_ledger_entries LIKE 'seq'")
    if cursor.fetchone() is None:
        cursor.execute(
            "ALTER TABLE gateway_ledger_entries "
            "ADD COLUMN seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE AFTER id"
        )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS settlement_batch_entries (
          batch_id CHAR(36) NOT NULL,
          ledger_entry_id CHAR(36) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (batch_id, ledger_entry_id),
          UNIQUE KEY uq_batch_entry_once (ledger_entry_id),
          KEY idx_batch_entry_batch (batch_id)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS gateway_payouts (
          id CHAR(36) NOT NULL PRIMARY KEY,
          company_id VARCHAR(36) NOT NULL DEFAULT 'company',
          batch_id CHAR(36) NOT NULL,
          client_id CHAR(36) NOT NULL,
          destination_type ENUM('phone', 'paybill', 'till') NOT NULL,
          destination_value VARCHAR(32) NOT NULL,
          account_reference VARCHAR(32) NOT NULL DEFAULT '',
          amount DECIMAL(12,2) NOT NULL,
          idempotency_key VARCHAR(80) NOT NULL,
          originator_conversation_id VARCHAR(64) NULL,
          conversation_id VARCHAR(64) NULL,
          mpesa_receipt VARCHAR(40) NULL,
          status ENUM('queued', 'submitted', 'confirmed', 'failed', 'timed_out', 'needs_review', 'submitting') NOT NULL DEFAULT 'queued',
          attempt_count INT NOT NULL DEFAULT 0,
          last_error VARCHAR(255) NOT NULL DEFAULT '',
          submitted_at DATETIME NULL,
          confirmed_at DATETIME NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_gw_payout_idem (idempotency_key),
          UNIQUE KEY uq_gw_payout_ocid (originator_conversation_id),
          UNIQUE KEY uq_gw_payout_cid (conversation_id),
          UNIQUE KEY uq_gw_payout_receipt (mpesa_receipt),
          KEY idx_gw_payout_status (status, created_at),
          KEY idx_gw_payout_client (client_id, status)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS gateway_callback_events (
          id CHAR(36) NOT NULL PRIMARY KEY,
          endpoint VARCHAR(40) NOT NULL,
          dedupe_hash CHAR(64) NOT NULL,
          raw_body MEDIUMTEXT NULL,
          status ENUM('received', 'processed', 'failed') NOT NULL DEFAULT 'received',
          received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          processed_at DATETIME NULL,
          UNIQUE KEY uq_gw_callback_dedupe (dedupe_hash)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS gateway_audit_log (
          id CHAR(36) NOT NULL PRIMARY KEY,
          company_id VARCHAR(36) NOT NULL DEFAULT 'company',
          client_id CHAR(36) NULL,
          actor_kind ENUM('client', 'employee', 'system') NOT NULL,
          actor_id VARCHAR(40) NOT NULL DEFAULT '',
          action VARCHAR(60) NOT NULL,
          old_value MEDIUMTEXT NULL,
          new_value MEDIUMTEXT NULL,
          ip VARCHAR(45) NOT NULL DEFAULT '',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_gw_audit_company (company_id, created_at),
          KEY idx_gw_audit_client (client_id, created_at)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS gateway_fee_bands (
          id CHAR(36) NOT NULL PRIMARY KEY,
          company_id VARCHAR(36) NOT NULL DEFAULT 'company',
          min_amount DECIMAL(12,2) NOT NULL,
          max_amount DECIMAL(12,2) NULL,
          fee DECIMAL(12,2) NOT NULL,
          position INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_gw_fee_company (company_id, min_amount)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS gateway_notifications (
          id CHAR(36) NOT NULL PRIMARY KEY,
          company_id VARCHAR(36) NOT NULL DEFAULT 'company',
          audience ENUM('company', 'client') NOT NULL,
          client_id CHAR(36) NULL,
          kind VARCHAR(40) NOT NULL,
          subject VARCHAR(120) NOT NULL,
          detail VARCHAR(255) NOT NULL DEFAULT '',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_gw_notify_company (audience, created_at),
          KEY idx_gw_notify_client (client_id, created_at)
        )
        """
    )

    # Phase 1 created settlement_batches without batch_key; deterministic
    # batch keys (added for idempotent re-runs) need the column + unique key
    # on older deploys too.
    cursor.execute("SHOW COLUMNS FROM settlement_batches LIKE 'batch_key'")
    if cursor.fetchone() is None:
        cursor.execute(
            "ALTER TABLE settlement_batches "
            "ADD COLUMN batch_key VARCHAR(80) NOT NULL DEFAULT '' AFTER client_id"
        )
    cursor.execute("SHOW INDEX FROM settlement_batches WHERE Key_name = 'uq_gw_batch_key'")
    if cursor.fetchone() is None:
        cursor.execute(
            "ALTER TABLE settlement_batches ADD UNIQUE KEY uq_gw_batch_key (batch_key)"
        )

    # Unmatched C2B receipts land in the suspense queue before attribution —
    # client_id must be nullable on gateway_payments (older deploys created
    # it NOT NULL).
    cursor.execute("SHOW COLUMNS FROM gateway_payments LIKE 'client_id'")
    column = cursor.fetchone() or {}
    if str(column.get("Null", "")).upper() != "YES":
        cursor.execute("ALTER TABLE gateway_payments MODIFY COLUMN client_id CHAR(36) NULL")

    # 'submitting' marks a payout mid-flight between queued and submitted —
    # appended last so the enum change stays metadata-only on older deploys.
    cursor.execute("SHOW COLUMNS FROM gateway_payouts LIKE 'status'")
    status_column = str((cursor.fetchone() or {}).get("Type", ""))
    if "submitting" not in status_column:
        cursor.execute(
            "ALTER TABLE gateway_payouts MODIFY COLUMN status "
            "ENUM('queued','submitted','confirmed','failed','timed_out','needs_review','submitting') "
            "NOT NULL DEFAULT 'queued'"
        )

    # Append-only ledger: corrections are reversing entries, so the DB itself
    # refuses UPDATE and DELETE on ledger rows. Trigger creation needs the
    # TRIGGER privilege — plus SUPER or log_bin_trust_function_creators when
    # binary logging is on — so a restricted DB user gets a warning instead of
    # a failed deploy; the ledger is then kept append-only by the code paths.
    try:
        cursor.execute("DROP TRIGGER IF EXISTS gw_ledger_no_update")
        cursor.execute(
            """
            CREATE TRIGGER gw_ledger_no_update
            BEFORE UPDATE ON gateway_ledger_entries
            FOR EACH ROW
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'gateway_ledger_entries is append-only'
            """
        )
        cursor.execute("DROP TRIGGER IF EXISTS gw_ledger_no_delete")
        cursor.execute(
            """
            CREATE TRIGGER gw_ledger_no_delete
            BEFORE DELETE ON gateway_ledger_entries
            FOR EACH ROW
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'gateway_ledger_entries is append-only'
            """
        )
    except pymysql.err.OperationalError as error:
        if error.args and error.args[0] in (1044, 1142, 1419):
            print(
                "event=gateway-schema warning=ledger-triggers-skipped "
                f"error={error} — grant TRIGGER privilege or set "
                "log_bin_trust_function_creators=ON to enforce append-only in the DB",
                flush=True,
            )
        else:
            raise


def backfill_gateway_modes(cursor):
    """Seed isp_payout_settings for clients that have none.

    Any stored Daraja credentials (either scope) keep working, so those
    clients start as own_daraja — the portal keeps reading their saved rows
    exactly as before. Clients with nothing stored start as none. Nothing is
    ever backfilled to company_gateway: pooled collection is opt-in only.
    """
    cursor.execute(
        """
        INSERT INTO isp_payout_settings (client_id, gateway_mode)
        SELECT c.id,
          CASE WHEN EXISTS (
            SELECT 1 FROM isp_payment_settings s
            WHERE s.client_id = c.id AND s.consumer_key <> '' AND s.consumer_secret <> ''
          ) THEN 'own_daraja' ELSE 'none' END
        FROM isp_clients c
        WHERE NOT EXISTS (
          SELECT 1 FROM isp_payout_settings p WHERE p.client_id = c.id
        )
        """
    )


def ensure_callback_secret(cursor):
    """Return the company's callback secret, generating and sealing it once."""
    import gateway_crypto

    cursor.execute(
        "SELECT callback_secret_enc FROM company_daraja_settings WHERE id = 1"
    )
    row = cursor.fetchone()
    existing = (row or {}).get("callback_secret_enc")
    if existing:
        return gateway_crypto.open_secret(existing)
    secret = secrets.token_hex(16)
    cursor.execute(
        "UPDATE company_daraja_settings SET callback_secret_enc = %s WHERE id = 1",
        (gateway_crypto.seal(secret),),
    )
    return secret


def mask_msisdn(value):
    """2547•••••123 — enough to recognise a number, never enough to dial it."""
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    if len(digits) < 8:
        return "••••" if digits else ""
    return digits[:4] + "•" * (len(digits) - 7) + digits[-3:]


def dedupe_hash(*parts):
    body = "\x00".join(str(part or "") for part in parts)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def audit(cursor, client_id, actor_kind, actor_id, action, old=None, new=None, ip=""):
    cursor.execute(
        """
        INSERT INTO gateway_audit_log
          (id, company_id, client_id, actor_kind, actor_id, action, old_value, new_value, ip)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            str(uuid.uuid4()),
            COMPANY_ID,
            client_id,
            actor_kind,
            str(actor_id or "")[:40],
            action[:60],
            json.dumps(old) if old is not None else None,
            json.dumps(new) if new is not None else None,
            str(ip or "")[:45],
        ),
    )


def callback_secret(cursor):
    """The company's callback secret, opened — or None when none was issued.
    Unlike ensure_callback_secret this never creates one: callback endpoints
    must 404 until the director configures the gateway."""
    import gateway_crypto

    cursor.execute(
        "SELECT callback_secret_enc FROM company_daraja_settings WHERE id = 1"
    )
    row = cursor.fetchone()
    sealed = (row or {}).get("callback_secret_enc")
    return gateway_crypto.open_secret(sealed) if sealed else None


def public_base(cursor):
    """The public https base Daraja can reach this server on —
    ISP_GATEWAY_PUBLIC_URL when set, otherwise the base remembered from a
    director request through the public domain ('' when neither exists)."""
    base = (os.environ.get("ISP_GATEWAY_PUBLIC_URL") or "").strip().rstrip("/")
    if base:
        return base
    cursor.execute("SELECT public_base FROM company_daraja_settings WHERE id = 1")
    return ((cursor.fetchone() or {}).get("public_base") or "").strip().rstrip("/")


def remember_public_base(cursor, base):
    """Persist the https base observed on a director's request. No-op while
    ISP_GATEWAY_PUBLIC_URL overrides it; a blank base never clears a learned
    value — a later https request on a different domain overwrites it."""
    if (os.environ.get("ISP_GATEWAY_PUBLIC_URL") or "").strip():
        return
    base = (base or "").strip().rstrip("/")
    if not base.startswith("https://"):
        return
    cursor.execute(
        "UPDATE company_daraja_settings SET public_base = %s WHERE id = 1 AND public_base <> %s",
        (base, base),
    )


def log_callback_event(cursor, endpoint, body):
    """First-write-wins raw log for every inbound Daraja event.

    Returns the event id for a new event, or None when the dedupe hash is
    already logged — the caller still acks Safaricom but must not reprocess."""
    event_id = str(uuid.uuid4())
    dedupe = dedupe_hash(endpoint, json.dumps(body or {}, sort_keys=True))
    try:
        cursor.execute(
            """
            INSERT INTO gateway_callback_events (id, endpoint, dedupe_hash, raw_body)
            VALUES (%s, %s, %s, %s)
            """,
            (event_id, str(endpoint or "")[:40], dedupe, json.dumps(body or {})),
        )
    except pymysql.MySQLError:
        # Unique dedupe key — a replay of an event we already logged.
        return None
    return event_id


def mark_event_processed(cursor, event_id, status="processed"):
    cursor.execute(
        "UPDATE gateway_callback_events SET status = %s, processed_at = NOW() WHERE id = %s",
        (status, event_id),
    )


def record_stk_initiated(cursor, checkout_id, client_id, source, amount, msisdn,
                         subscriber_id=None, hotspot_purchase_id=None):
    """A pooled STK push just left for the company shortcode — park it as
    initiated so the poll, the callback, or the sweep can claim it."""
    payment_id = str(uuid.uuid4())
    cursor.execute(
        """
        INSERT INTO gateway_payments
          (id, client_id, source, subscriber_id, hotspot_purchase_id, channel,
           msisdn, amount, checkout_id, status)
        VALUES (%s, %s, %s, %s, %s, 'stk', %s, %s, %s, 'initiated')
        """,
        (
            payment_id,
            client_id,
            source,
            subscriber_id,
            hotspot_purchase_id,
            str(msisdn or "")[:20],
            amount,
            str(checkout_id or "")[:64],
        ),
    )
    return payment_id


def _last_balance(cursor, client_id):
    cursor.execute(
        """
        SELECT balance_after FROM gateway_ledger_entries
        WHERE client_id = %s ORDER BY seq DESC LIMIT 1
        """,
        (client_id,),
    )
    row = cursor.fetchone()
    return Decimal(str(row["balance_after"])) if row else Decimal("0")


def confirm_collection(cursor, checkout_id, receipt=None, amount=None, msisdn=None, raw=None):
    """Exactly-once crediting for a verified pooled collection.

    Must run inside the caller's transaction — the gateway_payments row is
    locked FOR UPDATE, so a racing poll/callback/sweep serializes here and the
    (payment_id, type) unique key makes a second ledger write impossible.

    Returns "confirmed" when this call credited it, "already" when another
    path won the race, "unmatched" when the verified amount disagrees with the
    requested amount (money is held in suspense, never dropped), or None when
    the checkout id is not a pooled payment."""
    cursor.execute(
        "SELECT * FROM gateway_payments WHERE checkout_id = %s FOR UPDATE",
        (str(checkout_id or "")[:64],),
    )
    payment = cursor.fetchone()
    if not payment:
        return None
    if payment["status"] == "confirmed":
        return "already"
    if amount is not None and Decimal(str(amount)) != Decimal(str(payment["amount"])):
        cursor.execute(
            """
            UPDATE gateway_payments
            SET status = 'unmatched', mpesa_receipt = COALESCE(%s, mpesa_receipt),
                msisdn = COALESCE(%s, msisdn), raw_callback = %s
            WHERE id = %s
            """,
            (receipt, str(msisdn or "")[:20] or None, raw, payment["id"]),
        )
        audit(cursor, payment["client_id"], "system", "gateway",
              "payment.unmatched", new={"paymentId": payment["id"], "reason": "amount-mismatch"})
        return "unmatched"
    # Serialize the running balance per client: the payout settings row exists
    # for every gateway client and acts as the per-client ledger write lock.
    cursor.execute(
        "SELECT client_id FROM isp_payout_settings WHERE client_id = %s FOR UPDATE",
        (payment["client_id"],),
    )
    balance = _last_balance(cursor, payment["client_id"]) + Decimal(str(payment["amount"]))
    cursor.execute(
        """
        UPDATE gateway_payments
        SET status = 'confirmed', mpesa_receipt = COALESCE(%s, mpesa_receipt),
            msisdn = COALESCE(%s, msisdn), confirmed_at = NOW(), raw_callback = %s
        WHERE id = %s
        """,
        (receipt, str(msisdn or "")[:20] or None, raw, payment["id"]),
    )
    cursor.execute(
        """
        INSERT INTO gateway_ledger_entries
          (id, client_id, payment_id, type, amount, balance_after)
        VALUES (%s, %s, %s, 'collection', %s, %s)
        """,
        (
            str(uuid.uuid4()),
            payment["client_id"],
            payment["id"],
            payment["amount"],
            balance,
        ),
    )
    audit(cursor, payment["client_id"], "system", "gateway",
          "payment.confirmed", new={"paymentId": payment["id"]})
    return "confirmed"


def fail_collection(cursor, checkout_id, status="failed", reason="", raw=None):
    """A verified terminal failure for a pooled STK request (cancelled,
    declined, expired). Money never moved — nothing goes to the ledger."""
    if status not in ("failed", "cancelled"):
        status = "failed"
    cursor.execute(
        """
        UPDATE gateway_payments
        SET status = %s, raw_callback = COALESCE(%s, raw_callback)
        WHERE checkout_id = %s AND status IN ('initiated', 'unmatched')
        """,
        (status, raw, str(checkout_id or "")[:64]),
    )
    return cursor.rowcount > 0


def record_c2b_unmatched(cursor, receipt, amount, msisdn, bill_reference, raw):
    """A C2B confirmation we cannot attribute — suspense queue for the
    director's operations panel. Duplicate receipts dedupe on the unique key."""
    payment_id = str(uuid.uuid4())
    try:
        cursor.execute(
            """
            INSERT INTO gateway_payments
              (id, client_id, source, channel, msisdn, amount, mpesa_receipt,
               account_reference, status, raw_callback)
            VALUES (%s, NULL, 'manual', 'c2b', %s, %s, %s, %s, 'unmatched', %s)
            """,
            (
                payment_id,
                str(msisdn or "")[:20],
                amount,
                str(receipt or "")[:40],
                str(bill_reference or "")[:40],
                raw,
            ),
        )
    except pymysql.MySQLError:
        return None
    audit(cursor, None, "system", "gateway", "payment.unmatched",
          new={"paymentId": payment_id, "reason": "unattributed-c2b"})
    return payment_id


def stale_initiated_payments(cursor, older_than_minutes=3, younger_than_hours=24):
    """Pooled STK rows still open — sweep candidates for the stale-payment job."""
    cursor.execute(
        """
        SELECT id, client_id, checkout_id, created_at
        FROM gateway_payments
        WHERE status = 'initiated' AND channel = 'stk' AND checkout_id IS NOT NULL
          AND created_at < DATE_SUB(NOW(), INTERVAL %s MINUTE)
          AND created_at > DATE_SUB(NOW(), INTERVAL %s HOUR)
        ORDER BY created_at
        LIMIT 50
        """,
        (int(older_than_minutes), int(younger_than_hours)),
    )
    return list(cursor.fetchall())


def record_balance_check(cursor, balance):
    """Last known available float on the payout shortcode (NULL clears)."""
    cursor.execute(
        "UPDATE company_daraja_settings SET last_known_balance = %s, last_balance_at = NOW() WHERE id = 1",
        (balance,),
    )


def apply_payout_result(cursor, originator_conversation_id, conversation_id,
                        status, receipt=None, error=None, extra_ids=None):
    """Match a B2C/B2B result or timeout callback to its payout by the
    conversation ids Daraja echoed back. extra_ids carries ids nested inside
    ResultParameters (Transaction Status answers echo the original
    OriginatorConversationID there, not at the top level). Returns the payout
    row (or None)."""
    candidates = [
        ("originator_conversation_id", originator_conversation_id),
        ("conversation_id", conversation_id),
    ]
    for value in extra_ids or ():
        candidates.append(("originator_conversation_id", value))
        candidates.append(("conversation_id", value))
    for column, value in candidates:
        if not value:
            continue
        cursor.execute(
            f"SELECT * FROM gateway_payouts WHERE {column} = %s FOR UPDATE",
            (str(value)[:64],),
        )
        payout = cursor.fetchone()
        if payout:
            break
    else:
        return None
    if payout["status"] in ("confirmed", "failed") and payout["status"] == status:
        return payout
    if payout["status"] == "confirmed":
        return payout  # a confirmed payout never walks back
    cursor.execute(
        """
        UPDATE gateway_payouts
        SET status = %s,
            mpesa_receipt = COALESCE(%s, mpesa_receipt),
            last_error = COALESCE(%s, last_error),
            conversation_id = COALESCE(%s, conversation_id),
            originator_conversation_id = COALESCE(%s, originator_conversation_id),
            confirmed_at = IF(%s = 'confirmed', NOW(), confirmed_at)
        WHERE id = %s
        """,
        (
            status,
            str(receipt or "")[:40] or None,
            str(error or "")[:255] or None,
            str(conversation_id or "")[:64] or None,
            str(originator_conversation_id or "")[:64] or None,
            status,
            payout["id"],
        ),
    )
    audit(cursor, payout["client_id"], "system", "gateway", f"payout.{status}",
          old={"status": payout["status"]}, new={"status": status, "payoutId": payout["id"]})
    return payout


# --- Payout execution & finalization (Phase 5) -------------------------------------


def claim_queued_payouts(cursor, limit=25):
    """Flip queued -> submitting one at a time; the UPDATE ... WHERE status
    guard is the atomic claim, so even a runner outside GET_LOCK can never
    pick the same payout twice."""
    cursor.execute(
        """
        SELECT * FROM gateway_payouts WHERE status = 'queued'
        ORDER BY created_at, id LIMIT %s
        """,
        (int(limit),),
    )
    claimed = []
    for payout in cursor.fetchall():
        cursor.execute(
            """
            UPDATE gateway_payouts
            SET status = 'submitting', attempt_count = attempt_count + 1
            WHERE id = %s AND status = 'queued'
            """,
            (payout["id"],),
        )
        if cursor.rowcount:
            payout["status"] = "submitting"
            claimed.append(payout)
    return claimed


def mark_payout_submitted(cursor, payout_id, originator_conversation_id, conversation_id):
    cursor.execute(
        """
        UPDATE gateway_payouts
        SET status = 'submitted', submitted_at = NOW(),
            originator_conversation_id = COALESCE(%s, originator_conversation_id),
            conversation_id = COALESCE(%s, conversation_id)
        WHERE id = %s AND status = 'submitting'
        """,
        (
            str(originator_conversation_id or "")[:64] or None,
            str(conversation_id or "")[:64] or None,
            payout_id,
        ),
    )
    return cursor.rowcount > 0


def mark_payout_undelivered(cursor, payout_id, status, error):
    """A synchronous rejection is 'failed'; a transport-level unknown is
    'needs_review' — never re-queued, because Daraja may have received it and
    an automatic re-send would be a double payment."""
    if status not in ("failed", "needs_review"):
        status = "needs_review"
    cursor.execute(
        """
        UPDATE gateway_payouts SET status = %s, last_error = %s
        WHERE id = %s AND status = 'submitting'
        """,
        (status, str(error or "")[:255], payout_id),
    )
    return cursor.rowcount > 0


def stale_submitted_payouts(cursor, older_than_minutes=10, limit=10):
    """Unresolved payouts the loop can still ask Daraja about — `submitted`
    awaiting a result, `timed_out` by the timeout callback, or `needs_review`
    that has identifiers (send outcome unknown but it reached Daraja).
    needs_review rows without identifiers can't be queried — they stay for a
    human (or payouts/check) to resolve."""
    cursor.execute(
        """
        SELECT * FROM gateway_payouts
        WHERE (
            status IN ('submitted', 'timed_out')
            OR (status = 'needs_review'
                AND (mpesa_receipt IS NOT NULL OR originator_conversation_id IS NOT NULL))
        )
          AND COALESCE(submitted_at, created_at) <= DATE_SUB(NOW(), INTERVAL %s MINUTE)
        ORDER BY COALESCE(submitted_at, created_at) LIMIT %s
        """,
        (int(older_than_minutes), int(limit)),
    )
    return list(cursor.fetchall())


def _share(total, basis, part, is_last, remaining):
    """Proportional share of a batch total for one payout; the final payout
    takes whatever remains so shares always sum exactly to the batch total."""
    total = Decimal(str(total or "0"))
    if total == 0:
        return Decimal("0.00")
    if is_last:
        return remaining
    if Decimal(str(basis or "0")) <= 0:
        return Decimal("0.00")
    return (total * Decimal(str(part)) / Decimal(str(basis))).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )


def finalize_payout_outcome(cursor, payout, receipt=None):
    """Ledger + batch rollup for a terminal payout result, inside the caller's
    transaction. Exactly-once: unique (payout_id, type) keys turn a second
    call into a no-op.

    On 'confirmed' the client's pool drains by three entries: payout (-sent),
    commission (-company's cut share), payout_fee (-estimated fee share), so a
    fully-delivered batch returns the running balance to where it started."""
    if payout["status"] == "confirmed":
        # Same per-client serializer confirm_collection uses — the running
        # balance_after stays consistent across concurrent finalizations.
        cursor.execute(
            "SELECT client_id FROM isp_payout_settings WHERE client_id = %s FOR UPDATE",
            (payout["client_id"],),
        )
        cursor.execute(
            "SELECT * FROM settlement_batches WHERE id = %s", (payout["batch_id"],)
        )
        batch = cursor.fetchone() or {}
        cursor.execute(
            "SELECT id, amount FROM gateway_payouts WHERE batch_id = %s ORDER BY created_at, id",
            (payout["batch_id"],),
        )
        siblings = list(cursor.fetchall())
        index = next((i for i, s in enumerate(siblings) if s["id"] == payout["id"]), len(siblings) - 1)
        is_last = index == len(siblings) - 1
        net = Decimal(str(batch.get("net") or "0"))
        # The last payout takes the true remainder — what earlier siblings of
        # this batch already debited, read from the ledger. Using the batch
        # total alone double-counted commission/fee on multi-payout batches.
        cursor.execute(
            """
            SELECT e.type, COALESCE(SUM(e.amount), 0) AS spent
            FROM gateway_ledger_entries e
            JOIN gateway_payouts po ON po.id = e.payout_id
            WHERE po.batch_id = %s AND e.type IN ('commission', 'payout_fee')
            GROUP BY e.type
            """,
            (payout["batch_id"],),
        )
        spent = {row["type"]: -Decimal(str(row["spent"])) for row in cursor.fetchall()}
        commission_total = Decimal(str(batch.get("commission") or "0"))
        fee_total = Decimal(str(batch.get("payout_fee") or "0"))
        balance = _last_balance(cursor, payout["client_id"])
        for kind, amount in (
            ("payout", -Decimal(str(payout["amount"]))),
            ("commission", -_share(commission_total, net, payout["amount"], is_last,
                                   commission_total - spent.get("commission", Decimal("0")))),
            ("payout_fee", -_share(fee_total, net, payout["amount"], is_last,
                                   fee_total - spent.get("payout_fee", Decimal("0")))),
        ):
            balance += amount
            try:
                cursor.execute(
                    """
                    INSERT INTO gateway_ledger_entries
                      (id, client_id, payout_id, type, amount, balance_after)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (str(uuid.uuid4()), payout["client_id"], payout["id"],
                     kind, amount, balance),
                )
            except pymysql.MySQLError:
                pass  # (payout_id, type) already written — duplicate result
    rollup_batch(cursor, payout["batch_id"])
    release_failed_batch(cursor, payout["batch_id"])


def rollup_batch(cursor, batch_id):
    """Fold payout states back into the batch row."""
    cursor.execute(
        "SELECT status, COUNT(*) AS n FROM gateway_payouts WHERE batch_id = %s GROUP BY status",
        (batch_id,),
    )
    counts = {row["status"]: row["n"] for row in cursor.fetchall()}
    if not counts:
        return None
    confirmed = counts.get("confirmed", 0)
    in_flight = sum(counts.get(s, 0) for s in ("queued", "submitting", "submitted"))
    if confirmed == sum(counts.values()):
        status = "paid"
    elif confirmed:
        status = "partially_paid"
    elif in_flight:
        status = "processing"
    else:
        status = "failed"
    cursor.execute(
        "UPDATE settlement_batches SET status = %s WHERE id = %s AND status <> %s",
        (status, batch_id, status),
    )
    return status


def release_failed_batch(cursor, batch_id):
    """Return a dead batch's ledger entries to the eligible pool so the money
    settles again on the next cycle — but only when no payout in the batch
    ever reached Daraja (no conversation ids, no receipt). Those payouts can
    never deliver and can never be matched by a later callback, so releasing
    their entries cannot double-pay. Batches with any in-flight, delivered,
    or Daraja-known payout stay parked for a human. The batch row stays
    'failed' as the audit trail."""
    cursor.execute(
        "SELECT status, client_id FROM settlement_batches WHERE id = %s FOR UPDATE",
        (batch_id,),
    )
    batch = cursor.fetchone() or {}
    if batch.get("status") != "failed":
        return False
    cursor.execute(
        """
        SELECT COUNT(*) AS n FROM gateway_payouts
        WHERE batch_id = %s AND (
            status <> 'failed'
            OR originator_conversation_id IS NOT NULL
            OR conversation_id IS NOT NULL
            OR mpesa_receipt IS NOT NULL
        )
        """,
        (batch_id,),
    )
    if (cursor.fetchone() or {}).get("n"):
        return False
    cursor.execute(
        "DELETE FROM settlement_batch_entries WHERE batch_id = %s", (batch_id,)
    )
    audit(cursor, batch.get("client_id"), "system", "gateway", "batch.released",
          new={"batchId": batch_id, "entries": cursor.rowcount})
    return True


# --- Custody views & ops queries (Phase 6) -----------------------------------------


CUSTODY_SQL = """
    CASE
      WHEN p.status = 'unmatched' THEN 'unmatched'
      WHEN p.status = 'initiated' THEN 'awaiting'
      WHEN p.status IN ('failed', 'cancelled') THEN 'failed'
      WHEN be.batch_id IS NULL THEN 'held'
      ELSE COALESCE((
        SELECT CASE
          WHEN COUNT(*) = SUM(po.status = 'confirmed') THEN 'delivered'
          WHEN SUM(po.status IN ('submitting', 'submitted')) > 0 THEN 'in_transit'
          WHEN SUM(po.status IN ('needs_review', 'timed_out')) > 0 THEN 'under_review'
          WHEN SUM(po.status = 'queued') > 0 THEN 'scheduled'
          ELSE 'failed'
        END
        FROM gateway_payouts po WHERE po.batch_id = be.batch_id
      ), 'scheduled')
    END
"""


def custody_rows(cursor, client_id=None, status=None, limit=200, offset=0):
    """Pooled payments with the custody status the ledgers show — every row
    answers 'where is this money right now'."""
    sql = f"""
        SELECT p.id, p.client_id, p.source, p.channel, p.msisdn, p.amount,
               p.mpesa_receipt, p.checkout_id, p.status, p.confirmed_at, p.created_at,
               be.batch_id, {CUSTODY_SQL} AS custody
        FROM gateway_payments p
        LEFT JOIN gateway_ledger_entries e ON e.payment_id = p.id AND e.type = 'collection'
        LEFT JOIN settlement_batch_entries be ON be.ledger_entry_id = e.id
    """
    params = []
    where = []
    if client_id:
        where.append("p.client_id = %s")
        params.append(client_id)
    if status:
        where.append("p.status = %s")
        params.append(status)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY p.created_at DESC, p.id DESC LIMIT %s OFFSET %s"
    params += [int(limit), int(offset)]
    cursor.execute(sql, params)
    rows = list(cursor.fetchall())
    for row in rows:
        row["msisdn"] = mask_msisdn(row.get("msisdn"))
    return rows


def company_overview(cursor):
    """Director's header numbers: company float, money held per client,
    and the counts that need action."""
    cursor.execute(
        "SELECT last_known_balance, last_balance_at, status, kill_switch "
        "FROM company_daraja_settings WHERE id = 1"
    )
    company = cursor.fetchone() or {}
    cursor.execute(
        """
        SELECT client_id, balance_after FROM gateway_ledger_entries e
        WHERE e.seq = (
          SELECT MAX(seq) FROM gateway_ledger_entries x WHERE x.client_id = e.client_id
        )
        """
    )
    balances = {row["client_id"]: row["balance_after"] for row in cursor.fetchall()}
    cursor.execute(
        """
        SELECT status, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
        FROM gateway_payouts GROUP BY status
        """
    )
    payouts = {row["status"]: {"count": row["n"], "total": str(row["total"])}
               for row in cursor.fetchall()}
    cursor.execute("SELECT COUNT(*) AS n FROM gateway_payments WHERE status = 'unmatched'")
    suspense = (cursor.fetchone() or {}).get("n", 0)
    cursor.execute(
        "SELECT COUNT(*) AS n FROM isp_payout_settings WHERE pending_change IS NOT NULL"
    )
    pending = (cursor.fetchone() or {}).get("n", 0)
    return {
        "float": {"balance": company.get("last_known_balance"),
                  "checkedAt": company.get("last_balance_at")},
        "gatewayStatus": company.get("status"),
        "killSwitch": bool(company.get("kill_switch")),
        "heldByClient": [
            {"clientId": cid, "balance": str(total)} for cid, total in balances.items()
        ],
        "payouts": payouts,
        "suspenseCount": suspense,
        "pendingDestinationChanges": pending,
    }


def client_custody(cursor, client_id=None):
    """Per-client custody card: pool balance, payout settings, batch counts."""
    params = []
    where = "WHERE s.gateway_mode = 'company_gateway'"
    if client_id:
        where += " AND s.client_id = %s"
        params.append(client_id)
    cursor.execute(
        f"""
        SELECT s.client_id, s.settlement_mode, s.hold_hours, s.destination_type,
               s.destination_value, s.account_reference, s.pending_change,
               s.pending_change_effective_at, s.min_payout_override, s.gateway_mode,
               c.first_name, c.last_name
        FROM isp_payout_settings s
        LEFT JOIN isp_clients c ON c.id = s.client_id {where}
        ORDER BY s.client_id
        """,
        params,
    )
    rows = list(cursor.fetchall())
    for row in rows:
        cursor.execute(
            """
            SELECT balance_after FROM gateway_ledger_entries
            WHERE client_id = %s ORDER BY seq DESC LIMIT 1
            """,
            (row["client_id"],),
        )
        latest = cursor.fetchone()
        row["balance"] = str(latest["balance_after"]) if latest else "0.00"
        cursor.execute(
            "SELECT status, COUNT(*) AS n FROM settlement_batches "
            "WHERE client_id = %s GROUP BY status",
            (row["client_id"],),
        )
        row["batches"] = {item["status"]: item["n"] for item in cursor.fetchall()}
        row["destination_value"] = mask_msisdn(row["destination_value"]) \
            if row.get("destination_type") == "phone" else row.get("destination_value")
        row["name"] = " ".join(
            part for part in (row.pop("first_name", ""), row.pop("last_name", "")) if part
        ) or None
    return rows


def client_directory(cursor):
    """Assign-target picker for the suspense queue — every ISP, pooled or not."""
    cursor.execute(
        "SELECT id, first_name, last_name, email, status FROM isp_clients "
        "ORDER BY first_name, last_name"
    )
    return [
        {
            "id": row["id"],
            "name": f"{row['first_name']} {row['last_name']}".strip(),
            "email": row["email"],
            "status": row["status"],
        }
        for row in cursor.fetchall()
    ]


def list_ledger(cursor, client_id, limit=200, offset=0):
    cursor.execute(
        """
        SELECT id, client_id, payment_id, payout_id, type, amount, balance_after, created_at
        FROM gateway_ledger_entries WHERE client_id = %s
        ORDER BY seq DESC LIMIT %s OFFSET %s
        """,
        (client_id, int(limit), int(offset)),
    )
    return list(cursor.fetchall())


def list_payouts(cursor, client_id=None, status=None, limit=200, offset=0):
    sql = """
        SELECT po.id, po.batch_id, po.client_id, po.destination_type, po.destination_value,
               po.account_reference, po.amount, po.status, po.mpesa_receipt, po.last_error,
               po.attempt_count, po.submitted_at, po.confirmed_at, po.created_at,
               b.status AS batch_status
        FROM gateway_payouts po
        LEFT JOIN settlement_batches b ON b.id = po.batch_id
    """
    params = []
    where = []
    if client_id:
        where.append("po.client_id = %s")
        params.append(client_id)
    if status:
        where.append("po.status = %s")
        params.append(status)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY po.created_at DESC, po.id DESC LIMIT %s OFFSET %s"
    params += [int(limit), int(offset)]
    cursor.execute(sql, params)
    rows = list(cursor.fetchall())
    for row in rows:
        if row.get("destination_type") == "phone":
            row["destination_value"] = mask_msisdn(row["destination_value"])
    return rows


def list_batches(cursor, client_id=None, limit=200, offset=0):
    sql = """
        SELECT b.id, b.client_id, b.period_from, b.period_to, b.gross, b.commission,
               b.payout_fee, b.net, b.status, b.created_at,
               (SELECT COUNT(*) FROM settlement_batch_entries be WHERE be.batch_id = b.id) AS entries,
               (SELECT COUNT(*) FROM gateway_payouts po WHERE po.batch_id = b.id) AS payouts
        FROM settlement_batches b
    """
    params = []
    if client_id:
        sql += " WHERE b.client_id = %s"
        params.append(client_id)
    sql += " ORDER BY b.created_at DESC, b.id DESC LIMIT %s OFFSET %s"
    params += [int(limit), int(offset)]
    cursor.execute(sql, params)
    return list(cursor.fetchall())


def suspense_payments(cursor, limit=200):
    """Unmatched money — C2B payments and STK amount mismatches waiting for
    a director to attribute them."""
    cursor.execute(
        """
        SELECT id, channel, msisdn, amount, mpesa_receipt, account_reference,
               checkout_id, created_at
        FROM gateway_payments WHERE status = 'unmatched'
        ORDER BY created_at DESC LIMIT %s
        """,
        (int(limit),),
    )
    rows = list(cursor.fetchall())
    for row in rows:
        row["msisdn"] = mask_msisdn(row.get("msisdn"))
    return rows


def pending_destination_changes(cursor):
    """Destination changes inside their cooling-off window — surfaced to the
    director so a fraudulent change can be spotted before money moves."""
    cursor.execute(
        """
        SELECT client_id, destination_type, destination_value, account_reference,
               pending_change, pending_change_effective_at
        FROM isp_payout_settings WHERE pending_change IS NOT NULL
        ORDER BY pending_change_effective_at
        """
    )
    rows = list(cursor.fetchall())
    for row in rows:
        if row.get("destination_type") == "phone":
            row["destination_value"] = mask_msisdn(row["destination_value"])
        row["current"] = {
            "destination_type": row.pop("destination_type"),
            "destination_value": row.pop("destination_value"),
            "account_reference": row.pop("account_reference"),
        }
    return rows


def audit_rows(cursor, client_id=None, limit=200, offset=0):
    sql = """
        SELECT id, client_id, actor_kind, actor_id, action, old_value, new_value, created_at
        FROM gateway_audit_log
    """
    params = []
    if client_id:
        sql += " WHERE client_id = %s"
        params.append(client_id)
    sql += " ORDER BY created_at DESC, id DESC LIMIT %s OFFSET %s"
    params += [int(limit), int(offset)]
    cursor.execute(sql, params)
    return list(cursor.fetchall())


def assign_unmatched(cursor, payment_id, client_id, actor_id):
    """Attribute a suspense payment to a client — the money was already
    received, so it becomes a confirmed collection entry and flows into that
    client's next settlement. Exactly-once: the status guard plus the unique
    (payment_id, 'collection') key make a second assign impossible."""
    cursor.execute(
        "SELECT * FROM gateway_payments WHERE id = %s FOR UPDATE", (payment_id,)
    )
    payment = cursor.fetchone()
    if not payment or payment["status"] != "unmatched":
        return None
    # Make sure the per-client serializer row exists before we lock it.
    cursor.execute(
        "INSERT INTO isp_payout_settings (client_id) VALUES (%s) "
        "ON DUPLICATE KEY UPDATE client_id = client_id",
        (client_id,),
    )
    cursor.execute(
        "SELECT client_id FROM isp_payout_settings WHERE client_id = %s FOR UPDATE",
        (client_id,),
    )
    cursor.execute(
        """
        UPDATE gateway_payments
        SET client_id = %s, status = 'confirmed', confirmed_at = NOW()
        WHERE id = %s AND status = 'unmatched'
        """,
        (client_id, payment_id),
    )
    if not cursor.rowcount:
        return None
    balance = _last_balance(cursor, client_id) + Decimal(str(payment["amount"]))
    cursor.execute(
        """
        INSERT INTO gateway_ledger_entries
          (id, client_id, payment_id, type, amount, balance_after)
        VALUES (%s, %s, %s, 'collection', %s, %s)
        """,
        (str(uuid.uuid4()), client_id, payment_id, payment["amount"], balance),
    )
    audit(cursor, client_id, "employee", actor_id, "payment.assigned",
          old={"status": "unmatched", "paymentId": payment_id},
          new={"status": "confirmed", "clientId": client_id})
    return {"payment_id": payment_id, "balance": balance}


def isp_gateway_summary(cursor, client_id):
    """Everything the ISP ledger page header needs."""
    cursor.execute(
        """
        SELECT gateway_mode, settlement_mode, hold_hours, destination_type,
               destination_value, account_reference, min_payout_override,
               pending_change, pending_change_effective_at,
               settle_every_n_tx, settle_schedule, last_settled_at
        FROM isp_payout_settings WHERE client_id = %s
        """,
        (client_id,),
    )
    settings = cursor.fetchone() or {}
    cursor.execute(
        """
        SELECT balance_after FROM gateway_ledger_entries
        WHERE client_id = %s ORDER BY seq DESC LIMIT 1
        """,
        (client_id,),
    )
    latest = cursor.fetchone()
    cursor.execute(
        """
        SELECT COUNT(*) AS n FROM gateway_payments
        WHERE client_id = %s AND status = 'confirmed'
          AND id NOT IN (
            SELECT e.payment_id FROM gateway_ledger_entries e
            JOIN settlement_batch_entries be ON be.ledger_entry_id = e.id
            WHERE e.client_id = %s
          )
        """,
        (client_id, client_id),
    )
    unbatched = (cursor.fetchone() or {}).get("n", 0)
    destination = dict(settings)
    if destination.get("destination_type") == "phone":
        destination["destination_value"] = mask_msisdn(destination["destination_value"])
    return {
        "mode": settings.get("gateway_mode"),
        "balance": str(latest["balance_after"]) if latest else "0.00",
        "unbatchedPayments": unbatched,
        "settlement": {
            "mode": settings.get("settlement_mode"),
            "holdHours": settings.get("hold_hours"),
            "minPayoutOverride": None
            if settings.get("min_payout_override") is None
            else str(settings["min_payout_override"]),
            "settleEveryNTx": settings.get("settle_every_n_tx"),
            "settleSchedule": _parse_schedule(settings.get("settle_schedule")),
            "lastSettledAt": _iso_or_none(settings.get("last_settled_at")),
        },
        "destination": {
            "type": destination.get("destination_type"),
            "value": destination.get("destination_value"),
            "accountReference": destination.get("account_reference"),
        },
        "pendingChange": destination.get("pending_change"),
        "pendingChangeEffectiveAt": _iso_or_none(destination.get("pending_change_effective_at")),
    }


def _iso_or_none(value):
    return value.isoformat(sep=" ") if hasattr(value, "isoformat") else value


def isp_payout_settings_row(cursor, client_id):
    cursor.execute(
        """
        SELECT gateway_mode, settlement_mode, hold_hours, destination_type,
               destination_value, account_reference, min_payout_override,
               pending_change, pending_change_effective_at,
               settle_every_n_tx, settle_schedule, last_settled_at
        FROM isp_payout_settings WHERE client_id = %s
        """,
        (client_id,),
    )
    row = cursor.fetchone()
    if not row:
        # Clients signed up after the startup backfill have no row yet —
        # answer with the column defaults instead of null so callers and the
        # settings page always get a usable settings object.
        row = {
            "gateway_mode": "none",
            "settlement_mode": "immediate",
            "hold_hours": 24,
            "destination_type": None,
            "destination_value": "",
            "account_reference": "",
            "min_payout_override": None,
            "pending_change": None,
            "pending_change_effective_at": None,
            "settle_every_n_tx": None,
            "settle_schedule": "[]",
            "last_settled_at": None,
        }
    if row.get("destination_type") == "phone":
        row["destination_value"] = mask_msisdn(row["destination_value"])
    row["settle_schedule"] = _parse_schedule(row.get("settle_schedule"))
    override = row.get("min_payout_override")
    row["min_payout_override"] = None if override is None else str(override)
    row["pending_change_effective_at"] = _iso_or_none(row.get("pending_change_effective_at"))
    row["last_settled_at"] = _iso_or_none(row.get("last_settled_at"))
    return row


def _parse_schedule(schedule_text):
    """settle_schedule is stored as JSON TEXT — hand the API an array."""
    try:
        parsed = json.loads(schedule_text or "[]")
    except ValueError:
        return []
    return parsed if isinstance(parsed, list) else []


def save_payout_settings(cursor, client_id, fields, actor_id):
    """Owner-only payout settings. Destination changes stage into
    pending_change with a 24h cooling-off (the settlement tick applies them);
    timing and mode changes are immediate. Everything is audited and
    notified — never a silent money-destination edit."""
    import gateway_notify

    cursor.execute(
        "INSERT INTO isp_payout_settings (client_id) VALUES (%s) "
        "ON DUPLICATE KEY UPDATE client_id = client_id",
        (client_id,),
    )
    cursor.execute(
        "SELECT * FROM isp_payout_settings WHERE client_id = %s FOR UPDATE", (client_id,)
    )
    row = cursor.fetchone()
    changed = {}

    mode = fields.get("gateway_mode")
    if mode and mode in ("company_gateway", "own_daraja", "none") and mode != row["gateway_mode"]:
        changed["gateway_mode"] = mode

    for column, lo, hi in (
        ("settlement_mode", None, None),
        ("hold_hours", 1, 720),
        ("settle_every_n_tx", 1, 10000),
    ):
        value = fields.get(column)
        if value is None:
            continue
        if column == "settlement_mode":
            if value in ("immediate", "delayed", "transactions", "scheduled") \
                    and value != row[column]:
                changed[column] = value
        else:
            value = int(value)
            if lo <= value <= hi and value != row[column]:
                changed[column] = value

    if "settle_every_n_tx" in fields and fields["settle_every_n_tx"] is None:
        if row["settle_every_n_tx"] is not None:
            changed["settle_every_n_tx"] = None
    if "settle_schedule" in fields and fields["settle_schedule"] != row["settle_schedule"]:
        changed["settle_schedule"] = fields["settle_schedule"]

    if "min_payout_override" in fields:
        value = fields["min_payout_override"]
        value = None if value in (None, "") else Decimal(str(value))
        if value != row.get("min_payout_override"):
            changed["min_payout_override"] = value

    destination = {
        "destination_type": fields.get("destination_type"),
        "destination_value": str(fields.get("destination_value") or "")[:32],
        "account_reference": str(fields.get("account_reference") or "")[:32],
    }
    destination_change = (
        destination["destination_type"] is not None
        and (
            destination["destination_type"] != row["destination_type"]
            or destination["destination_value"] != row["destination_value"]
            or destination["account_reference"] != row["account_reference"]
        )
    )

    if changed:
        sets = ", ".join(f"{column} = %s" for column in changed)
        cursor.execute(
            f"UPDATE isp_payout_settings SET {sets} WHERE client_id = %s",
            (*changed.values(), client_id),
        )
        audit(cursor, client_id, "client", actor_id, "settings.updated",
              old={key: str(row.get(key)) for key in changed},
              new={key: str(value) for key, value in changed.items()})

    outcome = "updated" if changed else "unchanged"
    if destination_change:
        if not row["destination_value"]:
            # First destination — no cooling-off needed; nothing to intercept.
            cursor.execute(
                """
                UPDATE isp_payout_settings
                SET destination_type = %s, destination_value = %s, account_reference = %s
                WHERE client_id = %s
                """,
                (destination["destination_type"], destination["destination_value"],
                 destination["account_reference"], client_id),
            )
            outcome = "destination-set"
        else:
            cursor.execute(
                """
                UPDATE isp_payout_settings
                SET pending_change = %s, pending_change_effective_at = NOW() + INTERVAL 24 HOUR
                WHERE client_id = %s
                """,
                (json.dumps(destination), client_id),
            )
            outcome = "destination-pending"
            gateway_notify.send(
                cursor,
                gateway_notify.notice(
                    "company", "destination_change",
                    "Payout destination change pending",
                    f"Client {client_id[:8]} queued a new {destination['destination_type']} "
                    f"destination — applies in 24h unless cancelled.",
                    client_id=client_id,
                ),
            )
            gateway_notify.send(
                cursor,
                gateway_notify.notice(
                    "client", "destination_change",
                    "Payout destination change pending",
                    "Your new payout destination applies after the 24-hour review window.",
                    client_id=client_id,
                ),
            )
        audit(cursor, client_id, "client", actor_id, "destination.change",
              old={"destinationType": row["destination_type"]},
              new={"destinationType": destination["destination_type"],
                   "coolingOff": outcome == "destination-pending"})
    return outcome


# --- company gateway ops settings ---------------------------------------------

_COMPANY_GATEWAY_WRITABLE = {
    "initiator_name", "initiator_password_enc", "payout_shortcode",
    "status", "kill_switch", "commission_percent", "commission_flat",
    "default_hold_hours", "min_payout", "max_payout_per_tx",
    "payout_fee_estimate", "txn_fees_enabled",
}


def company_gateway_row(cursor):
    cursor.execute("SELECT * FROM company_daraja_settings WHERE id = 1")
    return cursor.fetchone()


def fee_bands(cursor):
    """The company's transaction-charge table, ordered for range lookup."""
    cursor.execute(
        "SELECT id, min_amount, max_amount, fee FROM gateway_fee_bands "
        "WHERE company_id = %s ORDER BY min_amount",
        (COMPANY_ID,),
    )
    return cursor.fetchall()


def save_fee_bands(cursor, bands, actor_id):
    """Replace-all write — one transaction wraps the swap + audit."""
    cursor.execute("DELETE FROM gateway_fee_bands WHERE company_id = %s", (COMPANY_ID,))
    for position, band in enumerate(bands):
        cursor.execute(
            "INSERT INTO gateway_fee_bands "
            "(id, company_id, min_amount, max_amount, fee, position) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (
                str(uuid.uuid4()), COMPANY_ID,
                band["min"], band["max"], band["fee"], position,
            ),
        )
    audit(
        cursor, None, "employee", actor_id, "gateway.charges",
        new={
            "bands": [
                {
                    "min": str(b["min"]),
                    "max": None if b["max"] is None else str(b["max"]),
                    "fee": str(b["fee"]),
                }
                for b in bands
            ]
        },
    )


def band_fee(bands, amount):
    """The charge for one transaction — the band containing the amount
    collected for that payout (inclusive bounds; None max = no ceiling)."""
    amount = Decimal(str(amount))
    for band in bands or ():
        low = Decimal(str(band["min_amount"]))
        high = band.get("max_amount")
        high = Decimal(str(high)) if high is not None else None
        if amount >= low and (high is None or amount <= high):
            return Decimal(str(band["fee"]))
    return Decimal("0")


def save_company_gateway(cursor, updates, actor_id):
    """Whitelist update of the gateway ops columns + audit. Runs inside the
    caller's transaction — validation lives in gateway_api."""
    row = company_gateway_row(cursor)
    if not row:
        return None, "Configure the company Daraja credentials first."
    changed = {}
    for column in sorted(set(updates) & _COMPANY_GATEWAY_WRITABLE):
        new = updates[column]
        old = row.get(column)
        if str(old if old is not None else "") == str(new if new is not None else ""):
            continue
        changed[column] = new
    if not changed:
        return {"outcome": "unchanged"}, None
    sets = ", ".join(f"{column} = %s" for column in changed)
    cursor.execute(
        f"UPDATE company_daraja_settings SET {sets} WHERE id = 1",
        [int(v) if isinstance(v, bool) else v for v in changed.values()],
    )
    audit(
        cursor, None, "employee", actor_id, "gateway.settings",
        new={k: ("••••" if "password" in k else str(v)) for k, v in changed.items()},
    )
    return {"outcome": "saved"}, None


def fail_payout_manually(cursor, payout_id, actor_id):
    """Mark a needs_review/timed_out payout failed — only when it provably
    never reached Daraja (no conversation ids, no receipt). A payout that
    might be in flight must go through Transaction Status instead."""
    cursor.execute(
        "SELECT id, batch_id, status, originator_conversation_id, conversation_id, "
        "mpesa_receipt FROM gateway_payouts WHERE id = %s FOR UPDATE",
        (payout_id,),
    )
    row = cursor.fetchone()
    if not row:
        return None, "Payout not found."
    if row["status"] not in ("needs_review", "timed_out"):
        return None, (
            f"Only needs_review or timed_out payouts can be marked failed — "
            f"this one is {row['status']}."
        )
    if row.get("originator_conversation_id") or row.get("conversation_id") or row.get("mpesa_receipt"):
        return None, "This payout reached Daraja — check its status before failing it."
    cursor.execute(
        "UPDATE gateway_payouts SET status = 'failed', "
        "last_error = 'marked failed by operator — never reached Daraja' "
        "WHERE id = %s",
        (payout_id,),
    )
    rollup_batch(cursor, row["batch_id"])
    release_failed_batch(cursor, row["batch_id"])
    audit(cursor, None, "employee", actor_id, "payout.mark_failed",
          new={"payoutId": payout_id})
    return {"failed": payout_id}, None


# --- one-shot secret re-seal ---------------------------------------------------

# Every column written through seal_secret() — keyed by natural primary key.
_SEALED_SECRET_TABLES = {
    "company_daraja_settings": (("id",), ("consumer_secret", "passkey", "initiator_password_enc")),
    "isp_payment_settings": (("client_id", "scope"), ("consumer_secret", "passkey", "security_credential")),
    "company_other_gateway": (("id",), ("secret_key",)),
    "company_communication_settings": (("channel",), ("api_key",)),
    "company_push_settings": (("id",), ("vapid_private",)),
    "isp_communication_settings": (("client_id", "channel"), ("api_key",)),
}


def reseal_stored_secrets(connect):
    """Rewrite legacy-sealed or plaintext secrets into gcm1 envelopes.
    Idempotent — gcm1 blobs are skipped, so re-runs only touch stragglers.
    Returns the number of rows updated."""
    import gateway_crypto
    import routeros_api

    def open_any(value):
        if not value or gateway_crypto.is_sealed(value):
            return None
        try:
            return routeros_api.open_password(str(value))
        except routeros_api.RouterError:
            return str(value)

    updated = 0
    with connect() as db:
        with db.cursor() as cursor:
            for table, (keys, columns) in _SEALED_SECRET_TABLES.items():
                try:
                    cursor.execute(
                        f"SELECT {', '.join(keys + columns)} FROM {table}")
                    rows = list(cursor.fetchall())
                except Exception as error:
                    print(
                        f"event=gateway-reseal table={table} "
                        f"error={type(error).__name__}", flush=True)
                    continue
                for row in rows:
                    sets, params = [], []
                    for column in columns:
                        plain = open_any(row.get(column))
                        if plain is None:
                            continue
                        sets.append(f"{column} = %s")
                        params.append(gateway_crypto.seal(plain))
                    if not sets:
                        continue
                    where = " AND ".join(f"{key} = %s" for key in keys)
                    cursor.execute(
                        f"UPDATE {table} SET {', '.join(sets)} WHERE {where}",
                        params + [row[key] for key in keys],
                    )
                    updated += 1
            db.commit()
    return updated
