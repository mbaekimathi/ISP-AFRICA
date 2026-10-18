"""Saved PPPoE subscribers, billing rows, and FreeRADIUS SQL tables."""

import hashlib
import hmac
import json
import secrets
import socket
import time
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal

import pppoe_service
import routeros_api

CHECKS = {}


class PppoeError(Exception):
    def __init__(self, status, message, details=None):
        super().__init__(message)
        self.status = status
        self.details = details or {}


def ensure_schema(cursor):
    for column, definition in (
        ("ip_pool_start", "ip_pool_start VARCHAR(15) NULL"),
        ("ip_pool_end", "ip_pool_end VARCHAR(15) NULL"),
        ("pppoe_interface", "pppoe_interface VARCHAR(32) NULL"),
    ):
        cursor.execute("SHOW COLUMNS FROM isp_mikrotik_devices LIKE %s", (column,))
        if cursor.fetchone() is None:
            cursor.execute(f"ALTER TABLE isp_mikrotik_devices ADD COLUMN {definition}")
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS pppoe_subscribers (
          id CHAR(36) NOT NULL PRIMARY KEY,
          client_id CHAR(36) NOT NULL,
          first_name VARCHAR(60) NOT NULL,
          last_name VARCHAR(60) NOT NULL,
          phone VARCHAR(20) NOT NULL,
          email VARCHAR(120) NOT NULL DEFAULT '',
          building_name VARCHAR(80) NOT NULL DEFAULT '',
          house_number VARCHAR(40) NOT NULL DEFAULT '',
          pppoe_username VARCHAR(64) NOT NULL,
          password_sealed VARCHAR(255) NOT NULL,
          router_id CHAR(36) NOT NULL,
          package_id CHAR(36) NOT NULL,
          router_serial VARCHAR(64) NULL,
          static_ip VARCHAR(15) NULL,
          session_limit INT NOT NULL DEFAULT 1,
          access_interface VARCHAR(32) NOT NULL DEFAULT '',
          mtu INT NOT NULL DEFAULT 1492,
          status ENUM('pending_activation','active','suspended','expired','disconnected','cancelled') NOT NULL DEFAULT 'pending_activation',
          service ENUM('pppoe','hotspot') NOT NULL DEFAULT 'pppoe',
          start_date DATE NULL,
          created_by CHAR(36) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_pppoe_username (pppoe_username),
          UNIQUE KEY uq_pppoe_phone (phone),
          UNIQUE KEY uq_pppoe_serial (router_serial),
          KEY idx_pppoe_client (client_id, status)
        )
        """
    )
    cursor.execute("SHOW COLUMNS FROM pppoe_subscribers LIKE 'service'")
    if cursor.fetchone() is None:
        cursor.execute("ALTER TABLE pppoe_subscribers ADD COLUMN service ENUM('pppoe','hotspot') NOT NULL DEFAULT 'pppoe'")
    cursor.execute("SHOW COLUMNS FROM pppoe_subscribers LIKE 'deleted'")
    if cursor.fetchone() is None:
        cursor.execute("ALTER TABLE pppoe_subscribers ADD COLUMN deleted TINYINT NOT NULL DEFAULT 0")
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS pppoe_subscriptions (
          id CHAR(36) NOT NULL PRIMARY KEY,
          subscriber_id CHAR(36) NOT NULL,
          package_id CHAR(36) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          billing_cycle ENUM('weekly','monthly','quarterly','custom') NOT NULL DEFAULT 'monthly',
          cycle_days INT NOT NULL DEFAULT 30,
          start_date DATE NULL,
          next_due_date DATE NULL,
          expiry_date DATE NULL,
          grace_days INT NOT NULL DEFAULT 3,
          auto_renew TINYINT NOT NULL DEFAULT 1,
          billing_status ENUM('pending','paid','overdue','suspended','cancelled') NOT NULL DEFAULT 'pending',
          discount DECIMAL(10,2) NOT NULL DEFAULT 0,
          discount_reason VARCHAR(160) NOT NULL DEFAULT '',
          UNIQUE KEY uq_pppoe_subscription (subscriber_id)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS pppoe_invoices (
          id CHAR(36) NOT NULL PRIMARY KEY,
          client_id CHAR(36) NOT NULL,
          subscriber_id CHAR(36) NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          purpose VARCHAR(40) NOT NULL,
          status ENUM('pending','paid','void') NOT NULL DEFAULT 'pending',
          mpesa_reference VARCHAR(40) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_pppoe_invoice (subscriber_id, status)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS pppoe_payments (
          id CHAR(36) NOT NULL PRIMARY KEY,
          client_id CHAR(36) NOT NULL,
          subscriber_id CHAR(36) NOT NULL,
          invoice_id CHAR(36) NULL,
          amount DECIMAL(10,2) NOT NULL,
          method VARCHAR(20) NOT NULL,
          mpesa_reference VARCHAR(40) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_pppoe_payment (subscriber_id, created_at)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS pppoe_stk_requests (
          id CHAR(36) NOT NULL PRIMARY KEY,
          client_id CHAR(36) NOT NULL,
          subscriber_id CHAR(36) NOT NULL,
          package_id CHAR(36) NOT NULL,
          package_price DECIMAL(10,2) NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          phone VARCHAR(20) NOT NULL,
          checkout_id VARCHAR(64) NOT NULL,
          status ENUM('pending','processing','paid','failed') NOT NULL DEFAULT 'pending',
          last_error VARCHAR(255) NOT NULL DEFAULT '',
          paid_at TIMESTAMP NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_stk_checkout (checkout_id),
          KEY idx_stk_subscriber (subscriber_id, status)
        )
        """
    )
    cursor.execute("SHOW COLUMNS FROM pppoe_stk_requests LIKE 'mpesa_code'")
    if cursor.fetchone() is None:
        cursor.execute("ALTER TABLE pppoe_stk_requests ADD COLUMN mpesa_code VARCHAR(20) NOT NULL DEFAULT ''")
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS pppoe_vouchers (
          id CHAR(36) NOT NULL PRIMARY KEY,
          client_id CHAR(36) NOT NULL,
          subscriber_id CHAR(36) NOT NULL,
          stk_request_id CHAR(36) NULL,
          package_id CHAR(36) NULL,
          package_name VARCHAR(80) NOT NULL DEFAULT '',
          code VARCHAR(20) NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          checkout_id VARCHAR(64) NULL,
          status ENUM('issued','used','void') NOT NULL DEFAULT 'issued',
          issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          used_at TIMESTAMP NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_voucher_code (code),
          UNIQUE KEY uq_voucher_checkout (checkout_id),
          KEY idx_voucher_subscriber (subscriber_id, status)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS pppoe_events (
          id CHAR(36) NOT NULL PRIMARY KEY,
          client_id CHAR(36) NOT NULL,
          subscriber_id CHAR(36) NOT NULL,
          actor_id CHAR(36) NOT NULL,
          action VARCHAR(40) NOT NULL,
          reason VARCHAR(160) NOT NULL DEFAULT '',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_pppoe_event (subscriber_id, created_at)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS isp_radius_nas (
          router_id CHAR(36) NOT NULL PRIMARY KEY,
          nasname VARCHAR(128) NOT NULL,
          secret_sealed VARCHAR(255) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS radcheck (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(64) NOT NULL DEFAULT '',
          attribute VARCHAR(64) NOT NULL DEFAULT '',
          op CHAR(2) NOT NULL DEFAULT '==',
          value VARCHAR(253) NOT NULL DEFAULT '',
          KEY username (username(32))
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS radreply (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(64) NOT NULL DEFAULT '',
          attribute VARCHAR(64) NOT NULL DEFAULT '',
          op CHAR(2) NOT NULL DEFAULT ':=',
          value VARCHAR(253) NOT NULL DEFAULT '',
          KEY username (username(32))
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS radusergroup (
          username VARCHAR(64) NOT NULL DEFAULT '',
          groupname VARCHAR(64) NOT NULL DEFAULT '',
          priority INT NOT NULL DEFAULT 1,
          KEY username (username(32))
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS radgroupreply (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          groupname VARCHAR(64) NOT NULL DEFAULT '',
          attribute VARCHAR(64) NOT NULL DEFAULT '',
          op CHAR(2) NOT NULL DEFAULT ':=',
          value VARCHAR(253) NOT NULL DEFAULT '',
          KEY groupname (groupname(32))
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS radacct (
          radacctid BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          acctsessionid VARCHAR(64) NOT NULL DEFAULT '',
          acctuniqueid VARCHAR(32) NOT NULL DEFAULT '',
          username VARCHAR(64) NOT NULL DEFAULT '',
          nasipaddress VARCHAR(15) NOT NULL DEFAULT '',
          acctstarttime DATETIME NULL,
          acctupdatetime DATETIME NULL,
          acctstoptime DATETIME NULL,
          acctsessiontime INT UNSIGNED NULL,
          acctinputoctets BIGINT NULL,
          acctoutputoctets BIGINT NULL,
          callingstationid VARCHAR(50) NULL,
          acctterminatecause VARCHAR(32) NULL,
          framedipaddress VARCHAR(15) NULL,
          KEY username (username),
          KEY acctstoptime (acctstoptime),
          KEY idx_radacct_framed (framedipaddress, acctstoptime)
        )
        """
    )
    # The portal's captive-page lookup filters radacct by framedipaddress on
    # every request; without this index each hit scans the whole table.
    cursor.execute("SHOW INDEX FROM radacct WHERE Key_name = 'idx_radacct_framed'")
    if cursor.fetchone() is None:
        cursor.execute("ALTER TABLE radacct ADD KEY idx_radacct_framed (framedipaddress, acctstoptime)")
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS nas (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          nasname VARCHAR(128) NOT NULL,
          shortname VARCHAR(32) NULL,
          type VARCHAR(30) NULL DEFAULT 'mikrotik',
          ports INT NULL,
          secret VARCHAR(255) NOT NULL DEFAULT '',
          description VARCHAR(200) NULL,
          UNIQUE KEY nasname (nasname)
        )
        """
    )


def client_id_from(cursor, token):
    raw = (token or {}).get("isp_client_session")
    if not raw:
        raise PppoeError(401, "Sign in to the ISP client account before managing PPPoE clients.")
    cursor.execute(
        "SELECT account_id FROM isp_sessions WHERE token = %s AND account_kind = 'client'",
        (raw,),
    )
    row = cursor.fetchone()
    if not row:
        raise PppoeError(401, "Sign in to the ISP client account before managing PPPoE clients.")
    cursor.execute("SELECT status FROM isp_clients WHERE id = %s", (row["account_id"],))
    account = cursor.fetchone()
    if not account or account["status"] != "approved":
        raise PppoeError(403, "That account is still waiting for approval.")
    return row["account_id"]


def allow_username_check(client_id):
    now = time.time()
    if len(CHECKS) > 20000:
        for key, hits in list(CHECKS.items()):
            recent = [item for item in hits if now - item < 60]
            if recent:
                CHECKS[key] = recent
            else:
                del CHECKS[key]
    recent = [item for item in CHECKS.get(client_id, []) if now - item < 60]
    if len(recent) >= 30:
        return False
    recent.append(now)
    CHECKS[client_id] = recent
    return True


def stamp(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def as_day(value):
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    parsed = pppoe_service.parse_day(value)
    return None if parsed == "invalid" else parsed


def write_radius(cursor, username, plan):
    built = pppoe_service.radius_plan(plan)
    cursor.execute("DELETE FROM radcheck WHERE username = %s", (username,))
    cursor.execute("DELETE FROM radreply WHERE username = %s", (username,))
    cursor.execute("DELETE FROM radusergroup WHERE username = %s", (username,))
    for row in built["checks"]:
        cursor.execute(
            "INSERT INTO radcheck (username, attribute, op, value) VALUES (%s, %s, %s, %s)",
            (username, row["attribute"], row["op"], row["value"]),
        )
    for row in built["replies"]:
        cursor.execute(
            "INSERT INTO radreply (username, attribute, op, value) VALUES (%s, %s, %s, %s)",
            (username, row["attribute"], row["op"], row["value"]),
        )
    cursor.execute(
        "INSERT INTO radusergroup (username, groupname, priority) VALUES (%s, %s, 1)",
        (username, built["group"]),
    )
    cursor.execute("DELETE FROM radgroupreply WHERE groupname = %s", (built["group"],))
    for row in built["groupReplies"]:
        cursor.execute(
            "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (%s, %s, %s, %s)",
            (built["group"], row["attribute"], row["op"], row["value"]),
        )
    return built


def ensure_nas(cursor, router):
    nasname = router.get("tunnel_ip") or router["id"]
    cursor.execute("SELECT secret_sealed FROM isp_radius_nas WHERE router_id = %s", (router["id"],))
    existing = cursor.fetchone()
    if existing:
        try:
            known = routeros_api.open_password(existing["secret_sealed"])
        except routeros_api.RouterError:
            return None
        cursor.execute(
            """
            INSERT INTO nas (nasname, shortname, type, secret, description)
            VALUES (%s, %s, 'mikrotik', %s, %s)
            ON DUPLICATE KEY UPDATE secret = VALUES(secret), description = VALUES(description)
            """,
            (nasname, str(router.get("name") or "")[:32], known, router["id"]),
        )
        cursor.execute("UPDATE isp_radius_nas SET nasname = %s WHERE router_id = %s", (nasname, router["id"]))
        _drop_nas_cache()
        return None
    secret = secrets.token_urlsafe(18)
    sealed = routeros_api.seal_password(secret)
    cursor.execute(
        "INSERT INTO isp_radius_nas (router_id, nasname, secret_sealed) VALUES (%s, %s, %s)",
        (router["id"], nasname, sealed),
    )
    cursor.execute(
        """
        INSERT INTO nas (nasname, shortname, type, secret, description)
        VALUES (%s, %s, 'mikrotik', %s, %s)
        ON DUPLICATE KEY UPDATE secret = VALUES(secret), description = VALUES(description)
        """,
        (nasname, str(router.get("name") or "")[:32], secret, router["id"]),
    )
    _drop_nas_cache()
    return secret


def _drop_nas_cache():
    # Deferred import: radius_server already imports this module at top level.
    try:
        import radius_server

        radius_server.nas_cache_clear()
    except Exception:
        pass


def send_disconnect(host, secret, username, session_id="", framed=""):
    if not host or not secret:
        return "queued"
    identifier = secrets.randbelow(256)
    user = username.encode()
    attributes = bytes([1, len(user) + 2]) + user
    if session_id:
        sid = session_id.encode()
        attributes += bytes([44, len(sid) + 2]) + sid
    if framed:
        try:
            attributes += bytes([8, 6]) + socket.inet_aton(framed)
        except OSError:
            pass
    length = 20 + len(attributes)
    head = bytes([40, identifier, length >> 8, length & 255])
    authenticator = hashlib.md5(head + bytes(16) + attributes + secret.encode()).digest()
    packet = head + authenticator + attributes
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # PoD ACKs over the tunnel answer in tens of milliseconds — 0.8s is a
        # generous wait and keeps a silent NAS from stalling the API for 2s.
        sock.settimeout(0.8)
        sock.sendto(packet, (host, 3799))
        try:
            data, _source = sock.recvfrom(4096)
            if data and data[0] == 41:
                return "sent"
            if data and data[0] == 42:
                return "refused"
        except socket.timeout:
            return "no-answer"
        finally:
            sock.close()
    except OSError:
        return "queued"


def log_event(cursor, client_id, subscriber_id, actor_id, action, reason=""):
    cursor.execute(
        """
        INSERT INTO pppoe_events (id, client_id, subscriber_id, actor_id, action, reason)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (str(uuid.uuid4()), client_id, subscriber_id, actor_id, action, reason[:160]),
    )


def load_router(cursor, client_id, router_id):
    cursor.execute(
        """
        SELECT id, name, site, status, tunnel_status, tunnel_ip, ip_pool_start, ip_pool_end, pppoe_interface
        FROM isp_mikrotik_devices
        WHERE id = %s AND client_id = %s
        """,
        (router_id, client_id),
    )
    row = cursor.fetchone()
    if not row:
        return None
    return {
        "id": row["id"],
        "name": row["name"],
        "site": row["site"],
        "status": row["status"],
        "tunnelStatus": row["tunnel_status"],
        "tunnel_ip": row["tunnel_ip"],
        "poolStart": row.get("ip_pool_start"),
        "poolEnd": row.get("ip_pool_end"),
        "interface": row.get("pppoe_interface") or "",
    }


def load_package(cursor, client_id, package_id):
    cursor.execute(
        """
        SELECT id, name, price, download_mbps, upload_mbps, status, availability_routers, simultaneous_devices
        FROM isp_packages
        WHERE id = %s AND client_id = %s
        """,
        (package_id, client_id),
    )
    row = cursor.fetchone()
    if not row:
        return None
    try:
        routers = json.loads(row["availability_routers"] or "[]")
    except json.JSONDecodeError:
        routers = []
    return {
        "id": row["id"],
        "name": row["name"],
        "price": format(Decimal(row["price"]), ".2f"),
        "downloadMbps": int(row["download_mbps"]),
        "uploadMbps": int(row["upload_mbps"]),
        "status": row["status"],
        "devices": int(row["simultaneous_devices"] or 0),
        "routers": routers if isinstance(routers, list) else [],
    }


def context_for(cursor, client_id, payload, ignore_id=None):
    cursor.execute("SELECT pppoe_username FROM pppoe_subscribers")
    names = {row["pppoe_username"] for row in cursor.fetchall()}
    cursor.execute("SELECT username FROM radcheck")
    names.update(row["username"] for row in cursor.fetchall())
    if ignore_id:
        cursor.execute("SELECT pppoe_username FROM pppoe_subscribers WHERE id = %s", (ignore_id,))
        own = cursor.fetchone()
        if own:
            names.discard(own["pppoe_username"])
    cursor.execute("SELECT router_serial FROM pppoe_subscribers WHERE router_serial IS NOT NULL AND router_serial <> ''")
    serials = {row["router_serial"] for row in cursor.fetchall()}
    cursor.execute("SELECT phone FROM pppoe_subscribers")
    phones = {row["phone"] for row in cursor.fetchall()}
    router = load_router(cursor, client_id, str(payload.get("routerId") or ""))
    package = load_package(cursor, client_id, str(payload.get("packageId") or ""))
    cursor.execute("SELECT static_ip FROM pppoe_subscribers WHERE static_ip IS NOT NULL AND static_ip <> ''")
    used = {row["static_ip"] for row in cursor.fetchall()}
    pool = None
    interfaces = None
    if router and router.get("poolStart") and router.get("poolEnd"):
        pool = {"start": router["poolStart"], "end": router["poolEnd"]}
    if router and router.get("interface"):
        interfaces = [router["interface"]]
    return {
        "usernames": names,
        "serials": serials,
        "phones": phones,
        "router": router,
        "package": package,
        "usedIps": used,
        "interfaces": interfaces,
        "pool": pool,
    }


def begin(cursor):
    cursor.connection.begin()


def finish(cursor):
    cursor.connection.commit()


def abort(cursor):
    cursor.connection.rollback()


def create_invoice(cursor, client_id, subscriber_id, amount, purpose, status, reference=None):
    invoice_id = str(uuid.uuid4())
    cursor.execute(
        """
        INSERT INTO pppoe_invoices (id, client_id, subscriber_id, amount, purpose, status, mpesa_reference)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (invoice_id, client_id, subscriber_id, amount, purpose, status, reference),
    )
    return invoice_id


def create_payment(cursor, client_id, subscriber_id, invoice_id, amount, method, reference):
    cursor.execute(
        """
        INSERT INTO pppoe_payments (id, client_id, subscriber_id, invoice_id, amount, method, mpesa_reference)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (str(uuid.uuid4()), client_id, subscriber_id, invoice_id, amount, method, reference or None),
    )


VOUCHER_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def voucher_code():
    """Human-readable one-time voucher code, without look-alike characters."""
    return "-".join("".join(secrets.choice(VOUCHER_ALPHABET) for _ in range(4)) for _ in range(3))


def issue_voucher(cursor, client_id, subscriber_id, payload):
    """Record the one-time voucher a successful recharge bought.

    Keyed by the Daraja checkout id so repeated calls for the same payment
    return the same voucher instead of minting duplicates.
    """
    checkout_id = str(payload.get("checkoutId") or "").strip()[:64] or None
    if checkout_id:
        cursor.execute(
            "SELECT id, code, status FROM pppoe_vouchers WHERE checkout_id = %s",
            (checkout_id,),
        )
        existing = cursor.fetchone()
        if existing:
            return existing
    amount = Decimal(str(payload.get("amount") or "0"))
    code = voucher_code()
    for _attempt in range(5):
        cursor.execute("SELECT id FROM pppoe_vouchers WHERE code = %s", (code,))
        if not cursor.fetchone():
            break
        code = voucher_code()
    voucher_id = str(uuid.uuid4())
    cursor.execute(
        """
        INSERT INTO pppoe_vouchers
          (id, client_id, subscriber_id, stk_request_id, package_id, package_name, code, amount, checkout_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            voucher_id,
            client_id,
            subscriber_id,
            str(payload.get("stkRequestId") or "")[:36] or None,
            str(payload.get("packageId") or "")[:36] or None,
            str(payload.get("packageName") or "")[:80],
            code,
            format(amount, ".2f"),
            checkout_id,
        ),
    )
    return {"id": voucher_id, "code": code, "status": "issued"}


def voucher_for_checkout(cursor, checkout_id):
    cursor.execute(
        "SELECT id, code, status FROM pppoe_vouchers WHERE checkout_id = %s",
        (str(checkout_id or "")[:64],),
    )
    return cursor.fetchone()


def voucher_detail(cursor, code, client_id=None):
    """Receipt details for the thank-you page, or None for an unknown code."""
    scope = " AND v.client_id = %s" if client_id else ""
    params = (str(code or "").strip().upper()[:20], client_id) if client_id else (str(code or "").strip().upper()[:20],)
    cursor.execute(
        f"""
        SELECT v.code, v.amount, v.status, v.issued_at, v.used_at,
               COALESCE(NULLIF(v.package_name, ''), p.name, 'Subscription') AS package_name,
               s.first_name, s.last_name, s.pppoe_username
        FROM pppoe_vouchers v
        JOIN pppoe_subscribers s ON s.id = v.subscriber_id
        LEFT JOIN isp_packages p ON p.id = v.package_id
        WHERE v.code = %s{scope}
        """,
        params,
    )
    return cursor.fetchone()


def mark_vouchers_used(cursor, usernames):
    """Consume a subscriber's issued vouchers once their session is live.

    A voucher is single-use by design: once RADIUS accounting shows the
    subscriber online it flips to 'used' and can never be applied again.
    """
    names = [str(name) for name in usernames if str(name or "").strip()]
    if not names:
        return 0
    marks = ", ".join(["%s"] * len(names))
    cursor.execute(
        f"""
        UPDATE pppoe_vouchers v
        JOIN pppoe_subscribers s ON s.id = v.subscriber_id
        SET v.status = 'used', v.used_at = NOW()
        WHERE v.status = 'issued' AND s.pppoe_username IN ({marks})
        """,
        names,
    )
    return cursor.rowcount


def mark_hotspot_vouchers_used(cursor, usernames):
    """Consume issued hotspot vouchers whose login shows a live session."""
    names = [str(name) for name in usernames if str(name or "").strip()]
    if not names:
        return 0
    marks = ", ".join(["%s"] * len(names))
    cursor.execute(
        f"""
        UPDATE hotspot_vouchers
        SET status = 'used', used_at = NOW()
        WHERE status = 'issued' AND username IN ({marks})
        """,
        names,
    )
    return cursor.rowcount


def register_subscriber(cursor, client_id, payload):
    context = context_for(cursor, client_id, payload)
    checked = pppoe_service.validate_pppoe_provisioning(payload, context)
    if checked["errors"]:
        raise PppoeError(400, checked["errors"][0]["message"], {"errors": checked["errors"], "warnings": checked["warnings"]})
    plan = checked["normalized"]
    subscriber_id = str(uuid.uuid4())
    sealed = routeros_api.seal_password(plan["password"])
    net = Decimal(plan["price"]) - Decimal(plan["discount"])
    begin(cursor)
    try:
        cursor.execute(
            """
            INSERT INTO pppoe_subscribers (
              id, client_id, first_name, last_name, phone, email, building_name, house_number,
              pppoe_username, password_sealed, router_id, package_id, router_serial, static_ip,
              session_limit, access_interface, mtu, status, start_date, created_by
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                subscriber_id,
                client_id,
                plan["firstName"],
                plan["lastName"],
                plan["phone"],
                plan["email"],
                plan["buildingName"],
                plan["houseNumber"],
                plan["username"],
                sealed,
                plan["routerId"],
                plan["packageId"],
                plan["serial"] or None,
                plan["staticIp"],
                plan["sessionLimit"],
                plan["accessInterface"],
                plan["mtu"],
                plan["status"],
                plan["startDate"],
                client_id,
            ),
        )
        billing = "paid" if Decimal(plan["initialPayment"]) >= net and net > 0 else "pending"
        cursor.execute(
            """
            INSERT INTO pppoe_subscriptions (
              id, subscriber_id, package_id, price, billing_cycle, cycle_days, start_date,
              next_due_date, expiry_date, grace_days, auto_renew, billing_status, discount, discount_reason
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                str(uuid.uuid4()),
                subscriber_id,
                plan["packageId"],
                plan["price"],
                plan["billingCycle"],
                plan["cycleDays"],
                plan["startDate"],
                plan["nextDueDate"],
                plan["expiryDate"],
                plan["graceDays"],
                1 if plan["autoRenew"] else 0,
                billing,
                plan["discount"],
                plan["discountReason"],
            ),
        )
        if net > 0:
            invoice_status = "paid" if Decimal(plan["initialPayment"]) >= net else "pending"
            invoice_id = create_invoice(cursor, client_id, subscriber_id, format(net, ".2f"), "subscription", invoice_status)
            if Decimal(plan["initialPayment"]) > 0:
                create_payment(cursor, client_id, subscriber_id, invoice_id, plan["initialPayment"], "manual", payload.get("mpesaReference"))
        write_radius(
            cursor,
            plan["username"],
            {
                **plan,
                "sessionLimit": effective_session_limit(plan["sessionLimit"], (context.get("package") or {}).get("devices")),
            },
        )
        issued = ensure_nas(cursor, context["router"])
        log_event(cursor, client_id, subscriber_id, client_id, "register", plan["status"])
        finish(cursor)
    except PppoeError:
        abort(cursor)
        raise
    except Exception as error:
        abort(cursor)
        reason = str(error)
        if plan["password"] and plan["password"] in reason:
            reason = "The PPPoE client could not be saved. Nothing was provisioned."
        raise PppoeError(400, reason or "The PPPoE client could not be saved. Nothing was provisioned.") from error
    body = subscriber_detail(cursor, client_id, subscriber_id)
    body["warnings"] = checked["warnings"]
    body["password"] = plan["password"]
    if issued:
        body["radiusSecret"] = issued
    return body


def list_routers(cursor, client_id):
    cursor.execute(
        """
        SELECT id, name, site, status, tunnel_status
        FROM isp_mikrotik_devices
        WHERE client_id = %s AND status = 'active'
        ORDER BY name
        """,
        (client_id,),
    )
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "site": row["site"],
            "status": row["status"],
            "tunnelStatus": row["tunnel_status"],
        }
        for row in cursor.fetchall()
    ]


def packages_for_router(cursor, client_id, router_id):
    if not load_router(cursor, client_id, router_id):
        raise PppoeError(404, "That router was not found.")
    cursor.execute(
        """
        SELECT id, name, price, download_mbps, upload_mbps, status, availability_routers
        FROM isp_packages
        WHERE client_id = %s AND status = 'active'
        ORDER BY name
        """,
        (client_id,),
    )
    packages = []
    for row in cursor.fetchall():
        package = load_package(cursor, client_id, row["id"])
        if package and router_id in {str(item) for item in package["routers"]}:
            packages.append(
                {
                    "id": package["id"],
                    "name": package["name"],
                    "price": package["price"],
                    "downloadMbps": package["downloadMbps"],
                    "uploadMbps": package["uploadMbps"],
                }
            )
    return packages


def check_username(cursor, client_id, username):
    if not allow_username_check(client_id):
        raise PppoeError(429, "Too many username checks. Wait a moment and try again.")
    text = str(username or "").strip()
    candidates = {text.lower()} | {alias.lower() for alias in pppoe_service.phone_variants(text)}
    marks = ", ".join(["%s"] * len(candidates))
    cursor.execute(f"SELECT id FROM pppoe_subscribers WHERE LOWER(pppoe_username) IN ({marks})", list(candidates))
    taken = cursor.fetchone() is not None
    if not taken:
        cursor.execute(f"SELECT id FROM radcheck WHERE LOWER(username) IN ({marks})", list(candidates))
        taken = cursor.fetchone() is not None
    return {"username": text, "available": not taken}


def public_row(row):
    return {
        "id": row["id"],
        "firstName": row["first_name"],
        "lastName": row["last_name"],
        "phone": row["phone"],
        "email": row["email"],
        "username": row["pppoe_username"],
        "routerId": row["router_id"],
        "routerName": row.get("router_name") or "",
        "packageId": row["package_id"],
        "packageName": row.get("package_name") or "",
        "serial": row.get("router_serial") or "",
        "status": row["status"],
        "connection": pppoe_service.connection_label(
            int(row.get("open_sessions") or 0),
            int(row.get("any_sessions") or 0) > 0,
            row.get("tunnel_status") or "unknown",
        ),
        "routerStatus": pppoe_service.router_status(
            row["status"],
            row.get("open_sessions") or 0,
            as_day(row.get("expiry_date")),
            date.today(),
            row.get("last_action") or "",
            row.get("tunnel_status") or "unknown",
        ),
        "billingStatus": row.get("billing_status") or "pending",
        "expiry": stamp(row.get("expiry_date")),
        "price": format(Decimal(row["price"]), ".2f") if row.get("price") is not None else None,
        "downloadMbps": None if row.get("download_mbps") is None else int(row["download_mbps"]),
        "uploadMbps": None if row.get("upload_mbps") is None else int(row["upload_mbps"]),
    }


def human_bytes(value):
    size = float(value or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{int(size)} B" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def subscriber_used_percent(row):
    """How much of the current paid period the client has used up, as a percent.

    Packages with a data allowance measure bytes against the cap; uncapped
    packages measure days elapsed inside the current billing window.
    """
    amount = row.get("data_allowance_amount")
    unit = str(row.get("data_allowance_unit") or "").upper()
    used_bytes = int(row.get("cycle_bytes") or 0)
    if amount is not None and unit in {"MB", "GB"}:
        allowance = Decimal(amount) * (1024 ** 2 if unit == "MB" else 1024 ** 3)
        if allowance > 0:
            pct = min(999, int(Decimal(used_bytes) * 100 // allowance))
            return pct, f"{human_bytes(used_bytes)} of {amount} {unit}"
    expiry = as_day(row.get("expiry_date"))
    if not expiry:
        return None, ""
    cycle = max(1, int(row.get("cycle_days") or 30))
    period_start = expiry - timedelta(days=cycle)
    start = as_day(row.get("sub_start"))
    if start and start > period_start:
        period_start = start
    span = max(1, (expiry - period_start).days)
    elapsed = max(0, (date.today() - period_start).days)
    return min(100, elapsed * 100 // span), f"{min(elapsed, span)} of {span} days"


def list_subscribers(cursor, client_id, query, service="pppoe"):
    reconcile(cursor, client_id)
    where = ["s.client_id = %s", "s.service = %s", "s.deleted = 0"]
    args = [client_id, service]
    router = (query.get("router") or [""])[0]
    package = (query.get("package") or [""])[0]
    status = (query.get("status") or [""])[0]
    billing = (query.get("billing") or [""])[0]
    search = (query.get("q") or [""])[0].strip()
    if router:
        where.append("s.router_id = %s")
        args.append(router)
    if package:
        where.append("s.package_id = %s")
        args.append(package)
    router_states = {"surfing", "not_surfing", "expired", "expired_online", "suspended", "suspended_online", "disconnecting", "disconnected", "pending_activation"}
    if status in router_states or status in {"online", "offline", "unknown"}:
        pass
    elif status:
        where.append("s.status = %s")
        args.append(status)
    if billing:
        where.append("sub.billing_status = %s")
        args.append(billing)
    if search:
        where.append("(s.first_name LIKE %s OR s.last_name LIKE %s OR s.phone LIKE %s OR s.pppoe_username LIKE %s OR s.router_serial LIKE %s)")
        like = f"%{search}%"
        args.extend([like, like, like, like, like])
    try:
        limit = min(1000, max(1, int((query.get("limit") or ["1000"])[0])))
        offset = max(0, int((query.get("offset") or ["0"])[0]))
    except ValueError as error:
        raise PppoeError(400, "Enter a valid page size.") from error
    sql = f"""
        SELECT s.*, sub.billing_status, sub.expiry_date, sub.price, sub.next_due_date,
               sub.cycle_days, sub.start_date AS sub_start,
               p.name AS package_name, p.download_mbps, p.upload_mbps,
               p.data_allowance_amount, p.data_allowance_unit,
               d.name AS router_name, d.tunnel_status,
               (SELECT COUNT(*) FROM radacct a WHERE a.username = s.pppoe_username AND a.acctstoptime IS NULL) AS open_sessions,
               (SELECT COUNT(*) FROM radacct a WHERE a.username = s.pppoe_username) AS any_sessions,
               (SELECT e.action FROM pppoe_events e WHERE e.subscriber_id = s.id ORDER BY e.created_at DESC LIMIT 1) AS last_action,
               (SELECT COALESCE(SUM(a.acctinputoctets + a.acctoutputoctets), 0) FROM radacct a
                WHERE a.username = s.pppoe_username
                  AND a.acctstarttime >= GREATEST(COALESCE(sub.start_date, '1970-01-01'), DATE_SUB(COALESCE(sub.expiry_date, CURDATE()), INTERVAL COALESCE(sub.cycle_days, 30) DAY))
               ) AS cycle_bytes
        FROM pppoe_subscribers s
        JOIN pppoe_subscriptions sub ON sub.subscriber_id = s.id
        JOIN isp_packages p ON p.id = s.package_id
        LEFT JOIN isp_mikrotik_devices d ON d.id = s.router_id
        WHERE {' AND '.join(where)}
    """
    cursor.execute(sql, args)
    rows = []
    for row in cursor.fetchall():
        public = public_row(row)
        percent, detail = subscriber_used_percent(row)
        public["usedPercent"] = percent
        public["usedDetail"] = detail
        rows.append(public)
    rows.sort(key=lambda row: (-1 if row["usedPercent"] is None else -row["usedPercent"], row["firstName"], row["lastName"]))
    if status in router_states:
        wanted = {"expired", "expired_online"} if status == "expired" else {"suspended", "suspended_online"} if status == "suspended" else {status}
        rows = [row for row in rows if row["routerStatus"] in wanted]
    elif status in {"online", "offline", "unknown"}:
        rows = [row for row in rows if row["connection"] == status]
    total = len(rows)
    return {
        "subscribers": rows[offset:offset + limit],
        "total": total,
        "limit": limit,
        "offset": offset,
        "routers": list_routers(cursor, client_id),
        "packages": [
            {"id": item["id"], "name": item["name"]}
            for item in cursor_packages(cursor, client_id)
        ],
    }


def cursor_packages(cursor, client_id):
    cursor.execute(
        "SELECT id, name FROM isp_packages WHERE client_id = %s ORDER BY name",
        (client_id,),
    )
    return [{"id": row["id"], "name": row["name"]} for row in cursor.fetchall()]


def require_owned(cursor, client_id, subscriber_id):
    cursor.execute(
        """
        SELECT s.*, sub.billing_status, sub.expiry_date, sub.price, sub.next_due_date, sub.billing_cycle,
               sub.cycle_days, sub.grace_days, sub.auto_renew, sub.discount, sub.discount_reason, sub.start_date AS sub_start,
               p.name AS package_name, p.download_mbps, p.upload_mbps, p.simultaneous_devices AS package_devices,
               d.name AS router_name, d.tunnel_status, d.tunnel_ip, d.api_secret,
               (SELECT e.action FROM pppoe_events e WHERE e.subscriber_id = s.id ORDER BY e.created_at DESC LIMIT 1) AS last_action
        FROM pppoe_subscribers s
        JOIN pppoe_subscriptions sub ON sub.subscriber_id = s.id
        JOIN isp_packages p ON p.id = s.package_id
        LEFT JOIN isp_mikrotik_devices d ON d.id = s.router_id
        WHERE s.id = %s AND s.client_id = %s AND s.deleted = 0
        """,
        (subscriber_id, client_id),
    )
    row = cursor.fetchone()
    if not row:
        raise PppoeError(404, "That PPPoE client was not found.")
    cursor.execute(
        "SELECT COUNT(*) AS open_sessions FROM radacct WHERE username = %s AND acctstoptime IS NULL",
        (row["pppoe_username"],),
    )
    row["open_sessions"] = cursor.fetchone()["open_sessions"]
    cursor.execute("SELECT COUNT(*) AS any_sessions FROM radacct WHERE username = %s", (row["pppoe_username"],))
    row["any_sessions"] = cursor.fetchone()["any_sessions"]
    return row


def subscriber_detail(cursor, client_id, subscriber_id):
    row = require_owned(cursor, client_id, subscriber_id)
    body = public_row(row)
    body.update(
        {
            "buildingName": row["building_name"],
            "houseNumber": row["house_number"],
            "staticIp": row["static_ip"] or "",
            "sessionLimit": int(row["session_limit"]),
            "accessInterface": row["access_interface"],
            "mtu": int(row["mtu"]),
            "startDate": stamp(row["start_date"]),
            "nextDueDate": stamp(row["next_due_date"]),
            "graceDays": int(row["grace_days"]),
            "autoRenew": bool(row["auto_renew"]),
            "discount": format(Decimal(row["discount"]), ".2f"),
            "discountReason": row["discount_reason"],
            "billingCycle": row["billing_cycle"],
            "rateLimit": f"{int(row['upload_mbps'])}M/{int(row['download_mbps'])}M",
        }
    )
    body["billing"] = billing_block(cursor, subscriber_id, row)
    body["usage"] = usage_block(cursor, row["pppoe_username"])
    body["sessions"] = session_rows(cursor, row["pppoe_username"], 10, 0)["sessions"]
    body["events"] = event_rows(cursor, subscriber_id)
    current = current_session(cursor, row["pppoe_username"])
    body["live"] = {
        "connection": body["connection"],
        "ip": (current or {}).get("ip") or row["static_ip"] or "",
        "mac": (current or {}).get("mac") or "",
        "uptime": (current or {}).get("uptime") or "",
        "router": row["router_name"],
        "lastSeen": (current or {}).get("lastSeen"),
        "rates": live_rates(cursor, row) if body["connection"] == "online" else None,
    }
    body["devices"] = device_rows(cursor, row)
    return body


def current_session(cursor, username):
    cursor.execute(
        """
        SELECT framedipaddress, callingstationid, acctstarttime, acctupdatetime, acctinputoctets, acctoutputoctets
        FROM radacct
        WHERE username = %s AND acctstoptime IS NULL
        ORDER BY acctstarttime DESC
        LIMIT 1
        """,
        (username,),
    )
    row = cursor.fetchone()
    if not row:
        cursor.execute(
            """
            SELECT framedipaddress, callingstationid, acctstoptime
            FROM radacct WHERE username = %s ORDER BY COALESCE(acctstoptime, acctstarttime) DESC LIMIT 1
            """,
            (username,),
        )
        last = cursor.fetchone()
        if not last:
            return None
        return {"ip": last.get("framedipaddress") or "", "mac": last.get("callingstationid") or "", "uptime": "", "lastSeen": stamp(last.get("acctstoptime"))}
    started = row.get("acctstarttime")
    uptime = ""
    if isinstance(started, datetime):
        uptime = str(datetime.now() - started).split(".", 1)[0]
    return {
        "ip": row.get("framedipaddress") or "",
        "mac": row.get("callingstationid") or "",
        "uptime": uptime,
        "lastSeen": stamp(row.get("acctupdatetime") or row.get("acctstarttime")),
        "bytesIn": int(row.get("acctinputoctets") or 0),
        "bytesOut": int(row.get("acctoutputoctets") or 0),
    }


def session_device(cursor, row):
    """(host, api_secret) for the NAS actually holding the open session.

    Falls back to the assigned router when there is no live session — the
    subscriber's router_id can point at a deleted device.
    """
    host = row.get("tunnel_ip")
    secret = row.get("api_secret")
    username = row.get("pppoe_username")
    if not username:
        return host, secret
    cursor.execute(
        "SELECT nasipaddress FROM radacct WHERE username = %s AND acctstoptime IS NULL LIMIT 1",
        (username,),
    )
    session = cursor.fetchone()
    if session and session.get("nasipaddress"):
        cursor.execute(
            "SELECT tunnel_ip, api_secret FROM isp_mikrotik_devices WHERE tunnel_ip = %s LIMIT 1",
            (session["nasipaddress"],),
        )
        device = cursor.fetchone()
        if device and device.get("api_secret"):
            host, secret = device["tunnel_ip"], device["api_secret"]
    return host, secret


def live_rates(cursor, row):
    """Best-effort instantaneous throughput for the subscriber's dynamic PPPoE interface."""
    username = row.get("pppoe_username")
    if not username:
        return None
    host, secret = session_device(cursor, row)
    if not host or not secret:
        return None
    try:
        # Best-effort: a reachable router answers well under half a second, so
        # cap the wait instead of letting a dead tunnel stall the response.
        return routeros_api.subscriber_rates(host, routeros_api.open_password(secret), username, timeout=2)
    except Exception:
        return None


def purchase_gadgets(cursor, client_id, device_id, phone):
    """Gadget MACs this subscriber paid for on their router: hotspot bundle
    purchases and redeemed vouchers are recorded against the buyer's phone."""
    variants = sorted(pppoe_service.phone_variants(phone or ""))
    if not variants or not device_id:
        return []
    marks = ", ".join(["%s"] * len(variants))
    gadgets = []
    cursor.execute(
        f"""
        SELECT mac, ip, MAX(COALESCE(paid_at, created_at)) AS at_time
        FROM hotspot_purchases
        WHERE client_id = %s AND device_id = %s AND status = 'paid' AND mac <> '' AND phone IN ({marks})
        GROUP BY mac, ip
        """,
        (client_id, device_id, *variants),
    )
    for item in cursor.fetchall():
        gadgets.append({"mac": item["mac"], "ip": item.get("ip") or "", "lastSeen": stamp(item.get("at_time")), "via": "purchase"})
    cursor.execute(
        f"""
        SELECT v.redeemed_mac AS mac, v.redeemed_ip AS ip, v.used_at
        FROM hotspot_vouchers v
        JOIN hotspot_purchases h ON h.id = v.purchase_id
        WHERE h.client_id = %s AND h.device_id = %s AND h.phone IN ({marks})
          AND v.status = 'used' AND v.redeemed_mac <> ''
        """,
        (client_id, device_id, *variants),
    )
    for item in cursor.fetchall():
        gadgets.append({"mac": item["mac"], "ip": item.get("ip") or "", "lastSeen": stamp(item.get("used_at")), "via": "voucher"})
    return gadgets


def device_rows(cursor, row):
    """Per-device view of a subscriber's sessions, keyed by the dialing MAC.

    Live sessions come straight from the NAS (real uptime + byte counters);
    radacct provides per-device history and lifetime totals. When the router
    is reachable it is the authority on which devices are online — a stale
    open radacct row is not enough to mark a device connected.

    Gadgets behind the subscriber's router are merged in from the LAN side
    (DHCP leases, ARP, bridge and hotspot hosts). With an access interface
    saved on the subscriber only gadgets learned on that port count; without
    one, LAN reads just enrich devices we already know about, so one client
    never absorbs another's gadgets. The MAC holding the open session is
    flagged kind=router — it is the dialing CPE, not an end device.
    """
    username = row.get("pppoe_username") or ""
    devices = []
    if not username:
        return devices
    cursor.execute(
        """
        SELECT callingstationid AS mac,
               COUNT(*) AS sessions,
               COALESCE(SUM(CASE WHEN acctstoptime IS NOT NULL THEN acctsessiontime ELSE 0 END), 0) AS seconds,
               COALESCE(SUM(CASE WHEN acctstoptime IS NOT NULL THEN acctinputoctets ELSE 0 END), 0) AS bytes_in,
               COALESCE(SUM(CASE WHEN acctstoptime IS NOT NULL THEN acctoutputoctets ELSE 0 END), 0) AS bytes_out,
               COALESCE(SUM(CASE WHEN acctstoptime IS NULL THEN acctsessiontime ELSE 0 END), 0) AS open_seconds,
               COALESCE(SUM(CASE WHEN acctstoptime IS NULL THEN acctinputoctets ELSE 0 END), 0) AS open_bytes_in,
               COALESCE(SUM(CASE WHEN acctstoptime IS NULL THEN acctoutputoctets ELSE 0 END), 0) AS open_bytes_out,
               MAX(COALESCE(acctstoptime, acctupdatetime, acctstarttime)) AS last_seen,
               MAX(acctstoptime IS NULL) AS is_online,
               MAX(CASE WHEN acctstoptime IS NULL THEN acctstarttime END) AS online_since,
               MAX(CASE WHEN acctstoptime IS NULL THEN framedipaddress END) AS ip
        FROM radacct
        WHERE username = %s AND callingstationid IS NOT NULL AND callingstationid <> ''
        GROUP BY callingstationid
        ORDER BY is_online DESC, last_seen DESC
        """,
        (username,),
    )
    rows = cursor.fetchall()
    live = {}
    lan = {}
    lan_scoped = bool(str(row.get("access_interface") or "").strip())
    router_seen = False
    host, secret = session_device(cursor, row)
    if host and secret:
        try:
            password = routeros_api.open_password(secret)
            for session in routeros_api.live_sessions(host, password, username):
                live[routeros_api.norm_mac(session["mac"])] = session
            for gadget in routeros_api.lan_gadgets(host, password, row.get("access_interface") or ""):
                lan[routeros_api.norm_mac(gadget["mac"])] = gadget
            router_seen = True
        except Exception:
            live = {}
            lan = {}
    current = current_session(cursor, username) or {}
    router_key = routeros_api.norm_mac(current.get("mac"))
    now = datetime.now()
    index = {}
    seen = set()
    for item in rows:
        mac = item.get("mac") or ""
        key = routeros_api.norm_mac(mac)
        seen.add(key)
        seconds = int(item.get("seconds") or 0)
        bytes_in = int(item.get("bytes_in") or 0)
        bytes_out = int(item.get("bytes_out") or 0)
        since = item.get("online_since")
        ip = item.get("ip") or ""
        last_seen = item.get("last_seen")
        online = False
        online_for = ""
        current = live.get(key)
        if current is not None:
            online = True
            ip = current.get("ip") or ip
            online_for = current.get("uptime") or ""
            seconds += int(current.get("seconds") or 0)
            bytes_in += int(current.get("bytesIn") or 0)
            bytes_out += int(current.get("bytesOut") or 0)
            last_seen = now
        elif not router_seen and isinstance(since, datetime):
            # Router unreachable — trust the accounting state instead.
            online = True
            online_for = str(now - since).split(".", 1)[0]
            seconds += max(int(item.get("open_seconds") or 0), int((now - since).total_seconds()))
            bytes_in += int(item.get("open_bytes_in") or 0)
            bytes_out += int(item.get("open_bytes_out") or 0)
        gadget = lan.get(key) or {}
        device = {
            "mac": mac,
            "ip": ip or gadget.get("ip") or "",
            "name": gadget.get("name") or "",
            "kind": "router" if key and key == router_key else "gadget",
            "via": "pppoe",
            "sessions": int(item.get("sessions") or 0),
            "seconds": seconds,
            "bytesIn": bytes_in,
            "bytesOut": bytes_out,
            "online": online or bool(gadget.get("online")),
            "onlineFor": online_for or gadget.get("uptime") or "",
            "lastSeen": stamp(last_seen),
        }
        index[key] = device
        devices.append(device)
    for key, current in live.items():
        if key in seen:
            continue
        seen.add(key)
        device = {
            "mac": current.get("mac") or "",
            "ip": current.get("ip") or "",
            "name": (lan.get(key) or {}).get("name") or "",
            "kind": "router" if key and key == router_key else "gadget",
            "via": "pppoe",
            "sessions": 1,
            "seconds": int(current.get("seconds") or 0),
            "bytesIn": int(current.get("bytesIn") or 0),
            "bytesOut": int(current.get("bytesOut") or 0),
            "online": True,
            "onlineFor": current.get("uptime") or "",
            "lastSeen": stamp(now),
        }
        index[key] = device
        devices.insert(0, device)
    for gadget in purchase_gadgets(cursor, row["client_id"], row.get("router_id"), row.get("phone")):
        key = routeros_api.norm_mac(gadget["mac"])
        if not key or key in index:
            continue
        seen.add(key)
        sighting = lan.get(key) or {}
        device = {
            "mac": gadget["mac"],
            "ip": sighting.get("ip") or gadget["ip"],
            "name": sighting.get("name") or "",
            "kind": "gadget",
            "via": gadget["via"],
            "sessions": 0,
            "seconds": int(sighting.get("seconds") or 0),
            "bytesIn": int(sighting.get("bytesIn") or 0),
            "bytesOut": int(sighting.get("bytesOut") or 0),
            "online": bool(sighting.get("online")),
            "onlineFor": sighting.get("uptime") or "",
            "lastSeen": stamp(now) if sighting.get("online") else gadget["lastSeen"],
        }
        index[key] = device
        devices.append(device)
    if lan_scoped:
        # The access interface pins gadgets to this subscriber's router.
        for key, gadget in lan.items():
            if key in index:
                continue
            devices.append(
                {
                    "mac": gadget["mac"],
                    "ip": gadget["ip"],
                    "name": gadget["name"],
                    "kind": "router" if key and key == router_key else "gadget",
                    "via": gadget["via"],
                    "sessions": 0,
                    "seconds": int(gadget.get("seconds") or 0),
                    "bytesIn": int(gadget.get("bytesIn") or 0),
                    "bytesOut": int(gadget.get("bytesOut") or 0),
                    "online": bool(gadget.get("online")),
                    "onlineFor": gadget.get("uptime") or "",
                    "lastSeen": gadget.get("lastSeen") or (stamp(now) if gadget.get("online") else None),
                }
            )
    return devices


def session_rows(cursor, username, limit, offset):
    cursor.execute("SELECT COUNT(*) AS total FROM radacct WHERE username = %s", (username,))
    total = int(cursor.fetchone()["total"])
    cursor.execute(
        """
        SELECT acctstarttime, acctstoptime, acctsessiontime, framedipaddress, callingstationid,
               acctinputoctets, acctoutputoctets, acctterminatecause
        FROM radacct
        WHERE username = %s
        ORDER BY acctstarttime DESC
        LIMIT %s OFFSET %s
        """,
        (username, limit, offset),
    )
    sessions = []
    for row in cursor.fetchall():
        sessions.append(
            {
                "login": stamp(row["acctstarttime"]),
                "logout": stamp(row["acctstoptime"]),
                "duration": int(row["acctsessiontime"] or 0),
                "ip": row["framedipaddress"] or "",
                "mac": row["callingstationid"] or "",
                "bytesIn": int(row["acctinputoctets"] or 0),
                "bytesOut": int(row["acctoutputoctets"] or 0),
                "cause": row["acctterminatecause"] or "",
            }
        )
    return {"sessions": sessions, "total": total, "limit": limit, "offset": offset}


USAGE_BUCKETS = {
    "hour": "HOUR(a.acctstarttime)",
    "day": "DATE(a.acctstarttime)",
    "month": "DATE_FORMAT(a.acctstarttime, '%%Y-%%m')",
}


def usage_window(query):
    """Resolve ?view=day|period|month|year into a date range and bucket size.

    A day reports by hour, a period or month reports by day, and a year
    reports by month. `finish` is exclusive; every value falls back to a
    sensible default so an empty pick still renders the report.
    """
    mode = str((query.get("view") or [""])[0] or "month").strip().lower()
    today = date.today()
    if mode == "day":
        raw = str((query.get("date") or [""])[0]).strip()
        start = as_day(raw) if raw else today
        if start is None:
            raise PppoeError(400, "Pick a valid date.")
        finish = start + timedelta(days=1)
        return "day", start, finish, "hour", start.strftime("%d %b %Y")
    if mode == "period":
        raw_start = str((query.get("start") or [""])[0]).strip()
        raw_end = str((query.get("end") or [""])[0]).strip()
        start = as_day(raw_start) if raw_start else today - timedelta(days=29)
        finish = as_day(raw_end) if raw_end else today
        if raw_start and start is None:
            raise PppoeError(400, "Enter a valid start date.")
        if raw_end and finish is None:
            raise PppoeError(400, "Enter a valid end date.")
        if finish < start:
            raise PppoeError(400, "The end date cannot be before the start date.")
        if (finish - start).days > 366:
            raise PppoeError(400, "Pick a period of one year or less.")
        label = f"{start.strftime('%d %b %Y')} – {finish.strftime('%d %b %Y')}"
        return "period", start, finish + timedelta(days=1), "day", label
    if mode == "year":
        raw = str((query.get("year") or [""])[0]).strip()
        try:
            chosen = int(raw) if raw else today.year
        except ValueError:
            raise PppoeError(400, "Pick a valid year.") from None
        if chosen < 2000 or chosen > today.year:
            raise PppoeError(400, "Pick a year between 2000 and this year.")
        return "year", date(chosen, 1, 1), date(chosen + 1, 1, 1), "month", str(chosen)
    raw = str((query.get("month") or [""])[0]).strip()
    if raw:
        try:
            start = datetime.strptime(raw[:7], "%Y-%m").date().replace(day=1)
        except ValueError:
            raise PppoeError(400, "Pick a valid month.") from None
    else:
        start = today.replace(day=1)
    finish = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    return "month", start, finish, "day", start.strftime("%B %Y")


def usage_slots(start, finish, granularity):
    """Zero-filled buckets so the trend chart shows the quiet stretches too."""
    if granularity == "hour":
        return [(f"{hour:02d}", f"{hour:02d}:00") for hour in range(24)]
    slots = []
    cursor_day = start
    while cursor_day < finish:
        if granularity == "month":
            slots.append((cursor_day.strftime("%Y-%m"), cursor_day.strftime("%b")))
            cursor_day = (cursor_day.replace(day=28) + timedelta(days=4)).replace(day=1)
        else:
            slots.append((cursor_day.isoformat(), cursor_day.strftime("%d %b")))
            cursor_day += timedelta(days=1)
    return slots


def usage_series(rows, start, finish, granularity):
    totals = {}
    for row in rows:
        key = row["bucket"]
        if granularity == "hour":
            key = f"{int(key):02d}"
        elif granularity == "day":
            key = stamp(key)[:10]
        else:
            key = str(key)
        totals[key] = (int(row["bytes_in"]), int(row["bytes_out"]))
    return [
        {
            "key": key,
            "label": label,
            "bytesIn": totals.get(key, (0, 0))[0],
            "bytesOut": totals.get(key, (0, 0))[1],
        }
        for key, label in usage_slots(start, finish, granularity)
    ]


def usage_view(mode, start, finish, label):
    return {
        "mode": mode,
        "label": label,
        "start": start.isoformat(),
        "end": (finish - timedelta(days=1)).isoformat(),
    }


def general_usage(cursor, client_id, service, query):
    mode, start, finish, granularity, label = usage_window(query or {})
    cursor.execute(
        """
        SELECT s.id, s.first_name, s.last_name, s.pppoe_username, d.name AS router_name,
               COALESCE(SUM(a.acctinputoctets), 0) AS bytes_in,
               COALESCE(SUM(a.acctoutputoctets), 0) AS bytes_out
        FROM pppoe_subscribers s
        LEFT JOIN isp_mikrotik_devices d ON d.id = s.router_id
        LEFT JOIN radacct a ON a.username = s.pppoe_username
            AND a.acctstarttime >= %s AND a.acctstarttime < %s
        WHERE s.client_id = %s AND s.service = %s
        GROUP BY s.id, s.first_name, s.last_name, s.pppoe_username, d.name
        ORDER BY (bytes_in + bytes_out) DESC, s.first_name, s.last_name
        """,
        (start.isoformat(), finish.isoformat(), client_id, service),
    )
    clients = []
    range_in = 0
    range_out = 0
    for row in cursor.fetchall():
        download = int(row["bytes_in"] or 0)
        upload = int(row["bytes_out"] or 0)
        range_in += download
        range_out += upload
        clients.append(
            {
                "id": row["id"],
                "firstName": row["first_name"],
                "lastName": row["last_name"],
                "username": row["pppoe_username"],
                "routerName": row["router_name"],
                "bytesIn": download,
                "bytesOut": upload,
            }
        )
    cursor.execute(
        f"""
        SELECT {USAGE_BUCKETS[granularity]} AS bucket, COALESCE(SUM(a.acctinputoctets), 0) AS bytes_in,
               COALESCE(SUM(a.acctoutputoctets), 0) AS bytes_out
        FROM radacct a
        JOIN pppoe_subscribers s ON s.pppoe_username = a.username
        WHERE s.client_id = %s AND s.service = %s AND a.acctstarttime >= %s AND a.acctstarttime < %s
        GROUP BY {USAGE_BUCKETS[granularity]}
        ORDER BY bucket
        """,
        (client_id, service, start.isoformat(), finish.isoformat()),
    )
    return {
        "service": service,
        "view": usage_view(mode, start, finish, label),
        "clients": clients,
        "total": len(clients),
        "rangeBytesIn": range_in,
        "rangeBytesOut": range_out,
        "series": usage_series(cursor.fetchall(), start, finish, granularity),
    }


def usage_block(cursor, username):
    cursor.execute(
        """
        SELECT DATE(acctstarttime) AS day, COALESCE(SUM(acctinputoctets), 0) AS bytes_in,
               COALESCE(SUM(acctoutputoctets), 0) AS bytes_out
        FROM radacct
        WHERE username = %s AND acctstarttime >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
        GROUP BY DATE(acctstarttime)
        ORDER BY day
        """,
        (username,),
    )
    days = [
        {"day": stamp(row["day"]), "bytesIn": int(row["bytes_in"]), "bytesOut": int(row["bytes_out"])}
        for row in cursor.fetchall()
    ]
    cursor.execute(
        """
        SELECT COALESCE(SUM(acctinputoctets), 0) AS bytes_in, COALESCE(SUM(acctoutputoctets), 0) AS bytes_out
        FROM radacct
        WHERE username = %s AND acctstarttime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        """,
        (username,),
    )
    month = cursor.fetchone()
    return {"days": days, "monthBytesIn": int(month["bytes_in"]), "monthBytesOut": int(month["bytes_out"])}


def usage_trend(cursor, username, scale="hours"):
    since = routeros_api.trend_since(scale, datetime.now())
    cursor.execute(
        """
        SELECT acctstarttime AS started, acctstoptime AS ended
        FROM radacct
        WHERE username = %s AND (acctstoptime IS NULL OR acctstoptime >= %s)
        """,
        (username, since),
    )
    spans = [(row["started"], row["ended"]) for row in cursor.fetchall()]
    return routeros_api.trend_series(spans, scale=scale)


def billing_block(cursor, subscriber_id, row):
    cursor.execute(
        """
        SELECT id, amount, purpose, status, mpesa_reference, created_at
        FROM pppoe_invoices WHERE subscriber_id = %s ORDER BY created_at DESC
        """,
        (subscriber_id,),
    )
    invoices = [
        {
            "id": item["id"],
            "amount": format(Decimal(item["amount"]), ".2f"),
            "purpose": item["purpose"],
            "status": item["status"],
            "reference": item["mpesa_reference"] or "",
            "createdAt": stamp(item["created_at"]),
        }
        for item in cursor.fetchall()
    ]
    cursor.execute(
        """
        SELECT id, amount, method, mpesa_reference, created_at
        FROM pppoe_payments WHERE subscriber_id = %s ORDER BY created_at DESC
        """,
        (subscriber_id,),
    )
    payments = [
        {
            "id": item["id"],
            "amount": format(Decimal(item["amount"]), ".2f"),
            "method": item["method"],
            "reference": item["mpesa_reference"] or "",
            "createdAt": stamp(item["created_at"]),
        }
        for item in cursor.fetchall()
    ]
    outstanding = sum(Decimal(item["amount"]) for item in invoices if item["status"] == "pending")
    return {
        "invoices": invoices,
        "payments": payments,
        "outstanding": format(outstanding, ".2f"),
        "nextDueDate": stamp(row.get("next_due_date")),
        "expiry": stamp(row.get("expiry_date")),
        "billingStatus": row.get("billing_status"),
        "price": format(Decimal(row.get("price") or 0), ".2f"),
        "billingCycle": row.get("billing_cycle") or "monthly",
        "cycleDays": int(row.get("cycle_days") or 30),
        "graceDays": int(row.get("grace_days") or 0),
    }


def event_rows(cursor, subscriber_id):
    cursor.execute(
        """
        SELECT action, reason, created_at FROM pppoe_events
        WHERE subscriber_id = %s ORDER BY created_at DESC LIMIT 50
        """,
        (subscriber_id,),
    )
    return [{"action": row["action"], "reason": row["reason"], "at": stamp(row["created_at"])} for row in cursor.fetchall()]


UNLIMITED_SESSIONS = 255


def effective_session_limit(session_limit, package_devices):
    """How many sessions may stay open. A package device count above zero can
    only widen the per-subscriber limit, never take back sessions an admin
    already granted; zero on the package means unlimited."""
    devices = int(package_devices or 0)
    if devices <= 0:
        return UNLIMITED_SESSIONS
    return max(int(session_limit or 1), devices)


def plan_from_saved(row, active):
    password = routeros_api.open_password(row["password_sealed"])
    return {
        "password": password,
        "status": row["status"],
        "sessionLimit": effective_session_limit(row["session_limit"], row.get("package_devices")),
        "radiusActive": active,
        "expiryDate": stamp(row.get("expiry_date")),
        "staticIp": row["static_ip"] or None,
        "poolName": None if row["static_ip"] else "pppoe-pool",
        "rateLimit": f"{int(row['upload_mbps'])}M/{int(row['download_mbps'])}M",
        "groupName": f"pppoe-{row['package_id']}" if active else pppoe_service.RESTRICTED_GROUP,
    }


def subscription_can_surf(row, today):
    """A dialed session can use the internet only while the subscription is still active."""
    expiry = as_day(row.get("expiry_date"))
    if row.get("status") != "active":
        return False
    if row.get("billing_status") in ("suspended", "cancelled"):
        return False
    if expiry and today > expiry:
        return False
    return True


def sync_router_access(cursor, client_id, router_id):
    """Refresh RADIUS so only current subscriptions are allowed to dial and surf."""
    today = date.today()
    cursor.execute(
        """
        SELECT s.id, s.status, s.password_sealed, s.pppoe_username, s.package_id, s.session_limit,
               s.static_ip, sub.expiry_date, sub.billing_status, p.download_mbps, p.upload_mbps,
               p.simultaneous_devices AS package_devices
        FROM pppoe_subscribers s
        JOIN pppoe_subscriptions sub ON sub.subscriber_id = s.id
        JOIN isp_packages p ON p.id = s.package_id
        WHERE s.client_id = %s AND s.router_id = %s
        """,
        (client_id, router_id),
    )
    for row in cursor.fetchall():
        apply_plan(cursor, row, subscription_can_surf(row, today))


def apply_plan(cursor, row, active):
    plan = plan_from_saved(row, active)
    write_radius(cursor, row["pppoe_username"], plan)
    return plan


def coa_for(cursor, row, username):
    """Disconnect-Request to the NAS that actually holds the session.

    radacct.nasipaddress is where the PPPoE session really lives; a subscriber's
    router_id can be stale (deleted/ migrated router) and sending the DM there
    silently drops nothing. Falls back to the assigned router when no session is
    open, so the next dial still starts clean.
    """
    cursor.execute(
        """
        SELECT nasipaddress, acctsessionid, framedipaddress
        FROM radacct WHERE username = %s AND acctstoptime IS NULL
        """,
        (username,),
    )
    sessions = cursor.fetchall()
    if sessions:
        result = "queued"
        for session in sessions:
            host = (session.get("nasipaddress") or "").strip()
            if not host:
                continue
            cursor.execute("SELECT secret FROM nas WHERE nasname = %s LIMIT 1", (host,))
            nas = cursor.fetchone()
            if not nas or not nas.get("secret"):
                continue
            outcome = send_disconnect(
                host,
                nas["secret"],
                username,
                session.get("acctsessionid") or "",
                session.get("framedipaddress") or "",
            )
            if outcome != "queued":
                result = outcome
        return result
    cursor.execute("SELECT secret_sealed, nasname FROM isp_radius_nas WHERE router_id = %s", (row["router_id"],))
    nas = cursor.fetchone()
    if not nas:
        return "queued"
    try:
        secret = routeros_api.open_password(nas["secret_sealed"])
    except routeros_api.RouterError:
        return "queued"
    return send_disconnect(nas["nasname"], secret, username)


def disconnect_router_clients(cursor, client_id, router_id, actor_id, reason):
    """Disconnect every client still assigned to a router that is being deleted."""
    cursor.execute(
        """
        SELECT s.id, s.status, s.password_sealed, s.pppoe_username, s.package_id, s.session_limit,
               s.static_ip, s.router_id, sub.expiry_date, p.download_mbps, p.upload_mbps,
               p.simultaneous_devices AS package_devices
        FROM pppoe_subscribers s
        JOIN pppoe_subscriptions sub ON sub.subscriber_id = s.id
        JOIN isp_packages p ON p.id = s.package_id
        WHERE s.client_id = %s AND s.router_id = %s
        """,
        (client_id, router_id),
    )
    count = 0
    for row in cursor.fetchall():
        try:
            apply_plan(cursor, row, False)
        except routeros_api.RouterError:
            pass
        cursor.execute("UPDATE pppoe_subscribers SET status = 'disconnected' WHERE id = %s", (row["id"],))
        cursor.execute(
            "UPDATE pppoe_subscriptions SET billing_status = 'cancelled' WHERE subscriber_id = %s",
            (row["id"],),
        )
        log_event(cursor, client_id, row["id"], actor_id, "disconnected", reason)
        coa_for(cursor, row, row["pppoe_username"])
        count += 1
    return count


def reconcile(cursor, client_id):
    today = date.today()
    cursor.execute(
        """
        SELECT s.id, s.status, s.start_date, s.password_sealed, s.pppoe_username, s.package_id, s.session_limit,
               s.static_ip, s.router_id, sub.expiry_date, sub.billing_status, sub.next_due_date,
               p.download_mbps, p.upload_mbps, p.simultaneous_devices AS package_devices
        FROM pppoe_subscribers s
        JOIN pppoe_subscriptions sub ON sub.subscriber_id = s.id
        JOIN isp_packages p ON p.id = s.package_id
        WHERE s.client_id = %s AND s.deleted = 0
        """,
        (client_id,),
    )
    for row in cursor.fetchall():
        due = as_day(row["next_due_date"])
        if row["billing_status"] == "pending" and due and today > due:
            cursor.execute(
                "UPDATE pppoe_subscriptions SET billing_status = 'overdue' WHERE subscriber_id = %s",
                (row["id"],),
            )
            row["billing_status"] = "overdue"
        nxt = pppoe_service.job_transition(row["status"], as_day(row["start_date"]), as_day(row["expiry_date"]), today)
        if nxt:
            cursor.execute("UPDATE pppoe_subscribers SET status = %s WHERE id = %s", (nxt, row["id"]))
            row["status"] = nxt
            if nxt == "expired":
                cursor.execute(
                    "UPDATE pppoe_subscriptions SET billing_status = 'suspended' WHERE subscriber_id = %s AND billing_status <> 'cancelled'",
                    (row["id"],),
                )
                if row["billing_status"] != "cancelled":
                    row["billing_status"] = "suspended"
            log_event(cursor, client_id, row["id"], client_id, nxt, "Scheduled from the start or expiry date.")
        can_surf = subscription_can_surf(row, today)
        try:
            apply_plan(cursor, row, can_surf)
        except routeros_api.RouterError as error:
            print(f"event=pppoe-reconcile sub={row['id']} user={row['pppoe_username']} plan-error={error}", flush=True)
            continue
        kick = nxt is not None
        if not kick and not can_surf:
            # A blocked subscriber's legitimate session is capped by
            # Session-Timeout at RESTRICTED_SESSION_SECONDS — anything still
            # open past that was authorized under the old plan and must be
            # dropped so it redials into the suspended/expired address list.
            # Younger sessions are already restricted; kicking them every
            # sweep would knock devices off the portal page mid-payment.
            cursor.execute(
                """
                SELECT COUNT(*) AS stale_sessions
                FROM radacct
                WHERE username = %s AND acctstoptime IS NULL
                  AND acctstarttime < DATE_SUB(NOW(), INTERVAL %s SECOND)
                """,
                (row["pppoe_username"], pppoe_service.RESTRICTED_SESSION_SECONDS + 300),
            )
            kick = int(cursor.fetchone()["stale_sessions"] or 0) > 0
        if kick:
            outcome = coa_for(cursor, row, row["pppoe_username"])
            if outcome != "sent":
                print(f"event=pppoe-coa user={row['pppoe_username']} result={outcome}", flush=True)


def reconcile_all(connect):
    """Run the activation/expiry sweep for every client that has subscribers."""
    db = connect()
    try:
        with db.cursor() as cursor:
            cursor.execute("SELECT DISTINCT client_id FROM pppoe_subscribers")
            client_ids = [row["client_id"] for row in cursor.fetchall()]
        for client_id in client_ids:
            try:
                with db.cursor() as cursor:
                    reconcile(cursor, client_id)
            except Exception as error:
                print(f"event=pppoe-reconcile client={client_id} error={error}", flush=True)
    finally:
        db.close()


def set_status(cursor, client_id, subscriber_id, status, billing, reason, active):
    row = require_owned(cursor, client_id, subscriber_id)
    begin(cursor)
    try:
        apply_plan(cursor, row, active)
        cursor.execute("UPDATE pppoe_subscribers SET status = %s WHERE id = %s", (status, subscriber_id))
        if billing:
            cursor.execute(
                "UPDATE pppoe_subscriptions SET billing_status = %s WHERE subscriber_id = %s",
                (billing, subscriber_id),
            )
        log_event(cursor, client_id, subscriber_id, client_id, status, reason)
        finish(cursor)
    except Exception as error:
        abort(cursor)
        raise PppoeError(400, "The RADIUS update failed, so the client was left unchanged.") from error
    coa = coa_for(cursor, row, row["pppoe_username"])
    body = subscriber_detail(cursor, client_id, subscriber_id)
    body["coa"] = coa
    return body


def renew(cursor, client_id, subscriber_id, payload):
    row = require_owned(cursor, client_id, subscriber_id)
    amount = pppoe_service.money(payload.get("amount") or "0", "amount")
    if amount is None or amount <= 0:
        raise PppoeError(400, "Enter the verified payment amount before renewal.")
    reference = str(payload.get("mpesaReference") or "").strip()[:40]
    price = Decimal(row["price"] or 0)
    period = int(row["cycle_days"] or 30)
    if price <= 0 or period <= 0:
        raise PppoeError(400, "This subscription has no package price to bill against.")
    days = max(1, int(-(-amount * period // price)))
    anchor = None
    if payload.get("startDate"):
        anchor = as_day(payload.get("startDate"))
        if anchor is None:
            raise PppoeError(400, "Enter a valid start date.")
    if anchor is None:
        anchor = as_day(row["expiry_date"])
        today = date.today()
        if anchor is None or anchor < today:
            anchor = today
    due = anchor + timedelta(days=days)
    expiry = due + timedelta(days=int(row["grace_days"] or 0))
    begin(cursor)
    try:
        invoice_id = create_invoice(cursor, client_id, subscriber_id, format(amount, ".2f"), "renewal", "paid", reference)
        create_payment(cursor, client_id, subscriber_id, invoice_id, format(amount, ".2f"), "manual", reference)
        cursor.execute(
            """
            UPDATE pppoe_subscriptions
            SET next_due_date = %s, expiry_date = %s, billing_status = 'paid'
            WHERE subscriber_id = %s
            """,
            (due.isoformat(), expiry.isoformat(), subscriber_id),
        )
        cursor.execute("UPDATE pppoe_subscribers SET status = 'active' WHERE id = %s", (subscriber_id,))
        row["status"] = "active"
        apply_plan(cursor, row, True)
        log_event(cursor, client_id, subscriber_id, client_id, "renew", reference or "Payment recorded.")
        finish(cursor)
    except Exception as error:
        abort(cursor)
        raise PppoeError(400, "Renewal was not saved.") from error
    body = subscriber_detail(cursor, client_id, subscriber_id)
    body["coa"] = coa_for(cursor, row, row["pppoe_username"])
    body["daysPurchased"] = days
    return body


def activate(cursor, client_id, subscriber_id):
    row = require_owned(cursor, client_id, subscriber_id)
    if as_day(row["next_due_date"]) is None:
        start = as_day(row["sub_start"]) or date.today()
        due = pppoe_service.add_cycle(start, row["billing_cycle"], int(row["cycle_days"] or 30))
        expiry = due + timedelta(days=int(row["grace_days"] or 0))
        cursor.execute(
            "UPDATE pppoe_subscriptions SET start_date = %s, next_due_date = %s, expiry_date = %s WHERE subscriber_id = %s",
            (start, due, expiry, subscriber_id),
        )
        cursor.execute("UPDATE pppoe_subscribers SET start_date = %s WHERE id = %s", (start, subscriber_id))
    return set_status(cursor, client_id, subscriber_id, "active", None, "Activated.", True)


def reactivate(cursor, client_id, subscriber_id, payload):
    row = require_owned(cursor, client_id, subscriber_id)
    if not pppoe_service.can_reactivate(row["billing_status"], payload.get("override")):
        raise PppoeError(400, "Reactivation needs a paid balance, or an explicit override.")
    reason = str(payload.get("reason") or "").strip()
    if payload.get("override") and not reason:
        raise PppoeError(400, "Enter a reason for the override.")
    return set_status(cursor, client_id, subscriber_id, "active", "paid", reason or "Reactivated.", True)


def upgrade(cursor, client_id, subscriber_id, payload):
    row = require_owned(cursor, client_id, subscriber_id)
    package = load_package(cursor, client_id, str(payload.get("packageId") or ""))
    if not package or row["router_id"] not in {str(item) for item in package["routers"]}:
        raise PppoeError(400, "Choose a package linked to this router.")
    credit = Decimal("0.00")
    if payload.get("prorate"):
        credit = pppoe_service.prorate_credit(
            row["price"],
            as_day(row["next_due_date"]),
            date.today(),
            int(row["cycle_days"]),
        )
    begin(cursor)
    try:
        cursor.execute(
            "UPDATE pppoe_subscribers SET package_id = %s WHERE id = %s",
            (package["id"], subscriber_id),
        )
        cursor.execute(
            "UPDATE pppoe_subscriptions SET package_id = %s, price = %s WHERE subscriber_id = %s",
            (package["id"], package["price"], subscriber_id),
        )
        if credit > 0:
            create_invoice(cursor, client_id, subscriber_id, format(-credit, ".2f"), "prorate", "paid")
        row["package_id"] = package["id"]
        row["upload_mbps"] = package["uploadMbps"]
        row["download_mbps"] = package["downloadMbps"]
        apply_plan(cursor, row, row["status"] == "active")
        log_event(cursor, client_id, subscriber_id, client_id, "upgrade", package["name"])
        finish(cursor)
    except Exception as error:
        abort(cursor)
        raise PppoeError(400, "The package change was not saved.") from error
    body = subscriber_detail(cursor, client_id, subscriber_id)
    body["coa"] = coa_for(cursor, row, row["pppoe_username"])
    return body


def migrate(cursor, client_id, subscriber_id, payload):
    row = require_owned(cursor, client_id, subscriber_id)
    router = load_router(cursor, client_id, str(payload.get("routerId") or ""))
    if not router or router["status"] != "active":
        raise PppoeError(400, "Choose an active router.")
    package_id = str(payload.get("packageId") or row["package_id"])
    package = load_package(cursor, client_id, package_id)
    if not package or router["id"] not in {str(item) for item in package["routers"]}:
        raise PppoeError(400, "That package is not linked to the target router.")
    old_nas = row["router_id"]
    begin(cursor)
    try:
        cursor.execute(
            "UPDATE pppoe_subscribers SET router_id = %s, package_id = %s, static_ip = NULL WHERE id = %s",
            (router["id"], package["id"], subscriber_id),
        )
        cursor.execute(
            "UPDATE pppoe_subscriptions SET package_id = %s, price = %s WHERE subscriber_id = %s",
            (package["id"], package["price"], subscriber_id),
        )
        row["router_id"] = router["id"]
        row["package_id"] = package["id"]
        row["static_ip"] = None
        row["upload_mbps"] = package["uploadMbps"]
        row["download_mbps"] = package["downloadMbps"]
        apply_plan(cursor, row, row["status"] == "active")
        log_event(cursor, client_id, subscriber_id, client_id, "migrate", router["name"])
        finish(cursor)
    except Exception as error:
        abort(cursor)
        raise PppoeError(400, "The router move was not saved.") from error
    row["router_id"] = old_nas
    coa_for(cursor, row, row["pppoe_username"])
    return subscriber_detail(cursor, client_id, subscriber_id)


def disconnect(cursor, client_id, subscriber_id, payload):
    row = require_owned(cursor, client_id, subscriber_id)
    if str(payload.get("mode") or "session") == "terminate":
        reason = str(payload.get("reason") or "").strip()
        if not reason:
            raise PppoeError(400, "Enter a reason for termination.")
        body = set_status(cursor, client_id, subscriber_id, "disconnected", "cancelled", reason, False)
        return body
    open_count = int(row.get("open_sessions") or 0)
    action = pppoe_service.duplicate_session_action(
        open_count, effective_session_limit(row["session_limit"], row.get("package_devices"))
    )
    coa = coa_for(cursor, row, row["pppoe_username"])
    log_event(cursor, client_id, subscriber_id, client_id, "disconnect", action)
    body = subscriber_detail(cursor, client_id, subscriber_id)
    body["coa"] = coa
    body["sessionPolicy"] = action
    return body


def delete_subscriber(cursor, client_id, subscriber_id):
    """Remove a client: revoke every grant, kick live sessions, hide the record.

    The row is soft-deleted so payment and usage history survives, but the
    RADIUS rows are wiped — a redial is simply rejected. The unique fields are
    rewritten so the same phone, username, or serial can be registered again.
    """
    row = require_owned(cursor, client_id, subscriber_id)
    begin(cursor)
    try:
        for table in ("radcheck", "radreply", "radusergroup"):
            cursor.execute(f"DELETE FROM {table} WHERE username = %s", (row["pppoe_username"],))
        cursor.execute(
            """
            UPDATE pppoe_subscribers
            SET deleted = 1, status = 'cancelled',
                pppoe_username = LEFT(CONCAT(pppoe_username, '-del-', LEFT(id, 8)), 64),
                phone = LEFT(CONCAT('del-', LEFT(id, 8), '-', phone), 20),
                router_serial = IF(router_serial IS NULL, NULL, LEFT(CONCAT(router_serial, '-del-', LEFT(id, 8)), 64))
            WHERE id = %s
            """,
            (subscriber_id,),
        )
        cursor.execute(
            "UPDATE pppoe_subscriptions SET billing_status = 'cancelled' WHERE subscriber_id = %s",
            (subscriber_id,),
        )
        log_event(cursor, client_id, subscriber_id, client_id, "deleted", "Client record removed by the account operator.")
        finish(cursor)
    except Exception as error:
        abort(cursor)
        raise PppoeError(400, "The client could not be removed.") from error
    coa = coa_for(cursor, row, row["pppoe_username"])
    return {"deleted": True, "coa": coa}


def reset_password(cursor, client_id, subscriber_id, payload):
    row = require_owned(cursor, client_id, subscriber_id)
    password = str(payload.get("password") or "") or pppoe_service.generate_password()
    if not pppoe_service.password_ok(password):
        raise PppoeError(400, "Use 8 to 12 characters without O or l. A phone number like 0723864156 works.")
    begin(cursor)
    try:
        sealed = routeros_api.seal_password(password)
        cursor.execute(
            "UPDATE pppoe_subscribers SET password_sealed = %s WHERE id = %s",
            (sealed, subscriber_id),
        )
        row["password_sealed"] = sealed
        apply_plan(cursor, row, row["status"] == "active")
        log_event(cursor, client_id, subscriber_id, client_id, "password", "Password replaced.")
        finish(cursor)
    except Exception as error:
        abort(cursor)
        raise PppoeError(400, "The password was not changed.") from error
    body = subscriber_detail(cursor, client_id, subscriber_id)
    body["password"] = password
    return body


def reveal_password(cursor, client_id, subscriber_id):
    row = require_owned(cursor, client_id, subscriber_id)
    try:
        password = routeros_api.open_password(row["password_sealed"])
    except routeros_api.RouterError as error:
        raise PppoeError(400, "The saved password could not be read.") from error
    log_event(cursor, client_id, subscriber_id, client_id, "reveal", "Password shown.")
    return {"password": password}


def record_payment(cursor, client_id, subscriber_id, payload):
    require_owned(cursor, client_id, subscriber_id)
    amount = pppoe_service.money(payload.get("amount"), "amount")
    if amount is None or amount <= 0:
        raise PppoeError(400, "Enter the payment amount.")
    reference = str(payload.get("mpesaReference") or "").strip()[:40]
    method = "stk" if payload.get("method") == "stk" else "manual"
    if method == "stk":
        raise PppoeError(400, "M-Pesa STK push is not connected on this server yet. Record the payment after it arrives.")
    begin(cursor)
    try:
        invoice_id = create_invoice(cursor, client_id, subscriber_id, format(amount, ".2f"), "payment", "paid", reference)
        create_payment(cursor, client_id, subscriber_id, invoice_id, format(amount, ".2f"), method, reference)
        cursor.execute(
            "UPDATE pppoe_subscriptions SET billing_status = 'paid' WHERE subscriber_id = %s",
            (subscriber_id,),
        )
        log_event(cursor, client_id, subscriber_id, client_id, "payment", reference or method)
        finish(cursor)
    except Exception as error:
        abort(cursor)
        raise PppoeError(400, "The payment was not saved.") from error
    return subscriber_detail(cursor, client_id, subscriber_id)


def edit_subscriber(cursor, client_id, subscriber_id, payload):
    row = require_owned(cursor, client_id, subscriber_id)
    first = str(payload.get("firstName", "")).strip()
    last = str(payload.get("lastName", "")).strip()
    phone = pppoe_service.normalize_phone(payload.get("phone"))
    email = str(payload.get("email", "")).strip()
    building = str(payload.get("buildingName", "")).strip()
    house = str(payload.get("houseNumber", "")).strip()
    serial = str(payload.get("serial") or "").strip()
    if len(first) < 2:
        raise PppoeError(400, "Enter a first name of at least 2 characters.")
    if len(last) > 60:
        raise PppoeError(400, "Enter a shorter last name.")
    if not phone:
        raise PppoeError(400, "Enter a Kenyan phone number, such as 07…, 01…, or +254….")
    if email and (len(email) > 120 or "@" not in email):
        raise PppoeError(400, "Enter a valid email address, or leave it empty.")
    cursor.execute(
        "SELECT id FROM pppoe_subscribers WHERE phone = %s AND id <> %s",
        (phone, subscriber_id),
    )
    if cursor.fetchone():
        raise PppoeError(400, "That phone number is already registered.")
    if serial:
        cursor.execute(
            "SELECT id FROM pppoe_subscribers WHERE router_serial = %s AND id <> %s",
            (serial, subscriber_id),
        )
        if cursor.fetchone():
            raise PppoeError(400, "That serial number is already registered.")
    cursor.execute(
        """
        UPDATE pppoe_subscribers
        SET first_name = %s, last_name = %s, phone = %s, email = %s, building_name = %s, house_number = %s, router_serial = %s
        WHERE id = %s AND client_id = %s
        """,
        (first, last, phone, email, building, house, serial or None, subscriber_id, client_id),
    )
    log_event(cursor, client_id, subscriber_id, client_id, "edit", "Customer details updated.")
    return subscriber_detail(cursor, client_id, subscriber_id)


def sessions_export(cursor, client_id, subscriber_id, query):
    row = require_owned(cursor, client_id, subscriber_id)
    try:
        limit = min(500, max(1, int((query.get("limit") or ["50"])[0])))
        offset = max(0, int((query.get("offset") or ["0"])[0]))
    except ValueError as error:
        raise PppoeError(400, "Enter a valid page size.") from error
    page = session_rows(cursor, row["pppoe_username"], limit, offset)
    if (query.get("export") or [""])[0] == "csv":
        lines = ["login,logout,duration,ip,bytes_in,bytes_out,cause"]
        for item in page["sessions"]:
            lines.append(
                ",".join(
                    [
                        item["login"] or "",
                        item["logout"] or "",
                        str(item["duration"]),
                        item["ip"],
                        str(item["bytesIn"]),
                        str(item["bytesOut"]),
                        item["cause"].replace(",", " "),
                    ]
                )
            )
        page["csv"] = "\n".join(lines)
        page["filename"] = f"{row['pppoe_username']}-sessions.csv"
    return page


def list_transactions(cursor, client_id, query):
    """Merged billing ledger for one client.

    Every row is a distinct record so the same money is never listed twice:
    a paid STK request or paid invoice already shows up as its payment row,
    so only open/failed requests and unlinked invoices are listed on their own.
    """
    service = str((query.get("service") or ["all"])[0] or "all").strip().lower()
    if service not in {"all", "pppoe", "hotspot"}:
        raise PppoeError(400, "Choose PPPoE, hotspot, or all services.")
    raw_from = str((query.get("from") or [""])[0]).strip()
    raw_to = str((query.get("to") or [""])[0]).strip()
    start = as_day(raw_from) if raw_from else None
    finish = as_day(raw_to) if raw_to else None
    if raw_from and start is None:
        raise PppoeError(400, "Enter a valid start date.")
    if raw_to and finish is None:
        raise PppoeError(400, "Enter a valid end date.")
    if start and finish and finish < start:
        raise PppoeError(400, "The end date cannot be before the start date.")

    def window(column):
        clause, args = "", []
        if start:
            clause += f" AND {column} >= %s"
            args.append(start.isoformat())
        if finish:
            clause += f" AND {column} < %s"
            args.append((finish + timedelta(days=1)).isoformat())
        return clause, args

    scope = "" if service == "all" else " AND s.service = %s"
    scope_args = [] if service == "all" else [service]
    rows = []
    collected = Decimal("0")
    outstanding = Decimal("0")

    def subscriber_fields(item):
        return {
            "customer": f"{item['first_name']} {item['last_name']}".strip(),
            "contact": item.get("phone") or item.get("pppoe_username") or "",
            "service": item["service"],
        }

    clause, args = window("p.created_at")
    cursor.execute(
        f"""
        SELECT p.id, p.amount, p.method, p.mpesa_reference, p.created_at,
               s.first_name, s.last_name, s.phone, s.pppoe_username, s.service,
               pkg.name AS package_name,
               (SELECT st.mpesa_code FROM pppoe_stk_requests st
                WHERE st.checkout_id LIKE CONCAT(p.mpesa_reference, '%%') AND st.mpesa_code <> ''
                LIMIT 1) AS mpesa_code
        FROM pppoe_payments p
        JOIN pppoe_subscribers s ON s.id = p.subscriber_id
        LEFT JOIN isp_packages pkg ON pkg.id = s.package_id
        WHERE p.client_id = %s{scope}{clause}
        """,
        [client_id, *scope_args, *args],
    )
    for item in cursor.fetchall():
        collected += Decimal(item["amount"])
        rows.append(
            {
                "id": f"pay-{item['id']}",
                "kind": "payment",
                "detail": item.get("package_name") or item["method"],
                "reference": item.get("mpesa_code") or item["mpesa_reference"] or "",
                "amount": format(Decimal(item["amount"]), ".2f"),
                "status": "paid",
                "createdAt": stamp(item["created_at"]),
                **subscriber_fields(item),
            }
        )

    clause, args = window("i.created_at")
    cursor.execute(
        f"""
        SELECT i.id, i.amount, i.purpose, i.status, i.mpesa_reference, i.created_at,
               s.first_name, s.last_name, s.phone, s.pppoe_username, s.service,
               pkg.name AS package_name
        FROM pppoe_invoices i
        JOIN pppoe_subscribers s ON s.id = i.subscriber_id
        LEFT JOIN isp_packages pkg ON pkg.id = s.package_id
        WHERE i.client_id = %s{scope}{clause}
          AND NOT EXISTS (SELECT 1 FROM pppoe_payments p WHERE p.invoice_id = i.id)
        """,
        [client_id, *scope_args, *args],
    )
    for item in cursor.fetchall():
        if item["status"] == "pending":
            outstanding += Decimal(item["amount"])
        detail = (item["purpose"] or "invoice").capitalize()
        if item.get("package_name"):
            detail += f" · {item['package_name']}"
        rows.append(
            {
                "id": f"inv-{item['id']}",
                "kind": "invoice",
                "detail": detail,
                "reference": item["mpesa_reference"] or "",
                "amount": format(Decimal(item["amount"]), ".2f"),
                "status": item["status"],
                "createdAt": stamp(item["created_at"]),
                **subscriber_fields(item),
            }
        )

    clause, args = window("r.created_at")
    cursor.execute(
        f"""
        SELECT r.id, r.amount, r.phone, r.checkout_id, r.mpesa_code, r.status, r.created_at,
               s.first_name, s.last_name, s.pppoe_username, s.service,
               pkg.name AS package_name
        FROM pppoe_stk_requests r
        JOIN pppoe_subscribers s ON s.id = r.subscriber_id
        LEFT JOIN isp_packages pkg ON pkg.id = r.package_id
        WHERE r.client_id = %s{scope}{clause} AND r.status <> 'paid'
        """,
        [client_id, *scope_args, *args],
    )
    for item in cursor.fetchall():
        detail = "M-Pesa prompt"
        if item.get("package_name"):
            detail += f" · {item['package_name']}"
        rows.append(
            {
                "id": f"stk-{item['id']}",
                "kind": "stk",
                "customer": f"{item['first_name']} {item['last_name']}".strip(),
                "contact": item["phone"] or item["pppoe_username"],
                "service": item["service"],
                "detail": detail,
                "reference": item.get("mpesa_code") or item["checkout_id"],
                "amount": format(Decimal(item["amount"]), ".2f"),
                "status": item["status"],
                "createdAt": stamp(item["created_at"]),
            }
        )

    if service != "pppoe":
        clause, args = window("h.created_at")
        cursor.execute(
            f"""
            SELECT h.id, h.amount, h.phone, h.checkout_id, h.mpesa_code, h.mac, h.status, h.devices, h.periods, h.created_at,
                   d.name AS router_name, pkg.name AS package_name
            FROM hotspot_purchases h
            LEFT JOIN isp_mikrotik_devices d ON d.id = h.device_id
            LEFT JOIN isp_packages pkg ON pkg.id = h.package_id
            WHERE h.client_id = %s{clause}
            """,
            [client_id, *args],
        )
        for item in cursor.fetchall():
            if item["status"] == "paid":
                collected += Decimal(item["amount"])
            detail_parts = [item.get("package_name") or "Hotspot package"]
            if int(item["devices"] or 1) > 1:
                detail_parts.append(f"{item['devices']} devices")
            if int(item["periods"] or 1) > 1:
                detail_parts.append(f"{item['periods']} periods")
            if item.get("router_name"):
                detail_parts.append(item["router_name"])
            rows.append(
                {
                    "id": f"hot-{item['id']}",
                    "kind": "purchase",
                    "customer": "Hotspot guest",
                    "contact": item["phone"] or item["mac"],
                    "service": "hotspot",
                    "detail": " · ".join(detail_parts),
                    "reference": item.get("mpesa_code") or item["checkout_id"],
                    "amount": format(Decimal(item["amount"]), ".2f"),
                    "status": item["status"],
                    "createdAt": stamp(item["created_at"]),
                }
            )

    rows.sort(key=lambda item: item["createdAt"] or "", reverse=True)
    return {
        "transactions": rows[:2000],
        "total": len(rows),
        "collected": format(collected, ".2f"),
        "outstanding": format(outstanding, ".2f"),
    }


def list_hotspot_clients(cursor, client_id, query):
    """Hotspot guests: one row per purchase, status derived from its vouchers.

    Hotspot buyers never become pppoe_subscribers rows — they exist only as
    purchases and single-use vouchers, so the clients page reads from them.
    """
    where = ["h.client_id = %s", "h.deleted = 0"]
    args = [client_id]
    router = (query.get("router") or [""])[0]
    package = (query.get("package") or [""])[0]
    status = (query.get("status") or [""])[0]
    billing = (query.get("billing") or [""])[0]
    search = (query.get("q") or [""])[0].strip()
    if router:
        where.append("h.device_id = %s")
        args.append(router)
    if package:
        where.append("h.package_id = %s")
        args.append(package)
    if billing:
        where.append("h.status = %s")
        args.append(billing)
    if search:
        where.append(
            """(h.phone LIKE %s OR h.mac LIKE %s OR EXISTS (
                SELECT 1 FROM hotspot_vouchers v
                WHERE v.purchase_id = h.id AND (v.code LIKE %s OR v.username LIKE %s)
            ))"""
        )
        like = f"%{search}%"
        args.extend([like, like, like, like])
    try:
        limit = min(1000, max(1, int((query.get("limit") or ["1000"])[0])))
        offset = max(0, int((query.get("offset") or ["0"])[0]))
    except ValueError as error:
        raise PppoeError(400, "Enter a valid page size.") from error
    cursor.execute(
        f"""
        SELECT h.id, h.phone, h.mac, h.status, h.amount, h.paid_at, h.created_at, h.device_id,
               d.name AS router_name, d.tunnel_ip, d.api_secret, pkg.name AS package_name,
               (SELECT GROUP_CONCAT(v.code ORDER BY v.issued_at SEPARATOR ', ') FROM hotspot_vouchers v WHERE v.purchase_id = h.id) AS codes,
               (SELECT GROUP_CONCAT(DISTINCT v.redeemed_mac) FROM hotspot_vouchers v WHERE v.purchase_id = h.id AND v.redeemed_mac IS NOT NULL AND v.redeemed_mac <> '') AS device_macs,
               (SELECT MAX(LEAST(100, ROUND(TIMESTAMPDIFF(SECOND, v.used_at, NOW()) * 100 / v.seconds))) FROM hotspot_vouchers v WHERE v.purchase_id = h.id AND v.status = 'used' AND v.used_at IS NOT NULL AND v.seconds > 0) AS used_pct,
               (SELECT COUNT(*) FROM hotspot_vouchers v WHERE v.purchase_id = h.id AND v.status = 'used') AS used_vouchers,
               (SELECT MAX(TIMESTAMPADD(SECOND, v.seconds, v.used_at)) FROM hotspot_vouchers v WHERE v.purchase_id = h.id AND v.status = 'used' AND v.used_at IS NOT NULL) AS surf_until
        FROM hotspot_purchases h
        LEFT JOIN isp_mikrotik_devices d ON d.id = h.device_id
        LEFT JOIN isp_packages pkg ON pkg.id = h.package_id
        WHERE {' AND '.join(where)}
        ORDER BY h.created_at DESC
        """,
        args,
    )
    items = cursor.fetchall()
    # One /ip/hotspot/host scan per reachable router — it lists every device
    # associated to the hotspot, so a registered device shows "connected" even
    # before its voucher is redeemed.
    router_macs = {}
    for item in items:
        macs = {str(item["mac"] or "").upper()} | {m.strip().upper() for m in (item.get("device_macs") or "").split(",") if m.strip()}
        macs.discard("")
        if macs and item.get("tunnel_ip") and item.get("api_secret"):
            router_macs.setdefault(str(item["device_id"]), set()).update(macs)
    live_hosts = {}
    for device_id, macs in router_macs.items():
        source = next((item for item in items if str(item["device_id"]) == device_id), None)
        if not source:
            continue
        try:
            for host_row in routeros_api.hotspot_hosts(
                source["tunnel_ip"], routeros_api.open_password(source["api_secret"]), macs=list(macs), timeout=3
            ):
                live_hosts[host_row["mac"]] = host_row
        except (routeros_api.RouterError, OSError):
            continue
    rows = []
    now = datetime.now()
    for item in items:
        used = int(item["used_vouchers"] or 0)
        surf_until = item["surf_until"] if isinstance(item["surf_until"], datetime) else None
        macs = {str(item["mac"] or "").upper()} | {m.strip().upper() for m in (item.get("device_macs") or "").split(",") if m.strip()}
        hosts = [live_hosts[mac] for mac in macs if mac in live_hosts]
        authorized = any(host["authorized"] for host in hosts)
        if item["status"] == "paid":
            if authorized:
                router_status = "surfing"
            elif hosts:
                router_status = "connected"
            else:
                router_status = "surfing" if used and (not surf_until or surf_until > now) else "expired" if used else "not_surfing"
        elif item["status"] == "pending":
            router_status = "connected" if hosts else "pending_activation"
        else:
            router_status = "connected" if hosts else "disconnected"
        rows.append(
            {
                "id": item["id"],
                "firstName": "Hotspot",
                "lastName": "guest",
                "phone": item["phone"],
                "username": item["codes"] or item["mac"],
                "routerName": item.get("router_name") or "",
                "packageName": item.get("package_name") or "",
                "status": "active" if item["status"] == "paid" else item["status"],
                "connection": "online" if (router_status in {"surfing", "connected"}) else "offline",
                "routerStatus": router_status,
                "billingStatus": item["status"],
                "expiry": stamp(surf_until) if surf_until else stamp(item["paid_at"] or item["created_at"]),
                "price": format(Decimal(item["amount"]), ".2f"),
                "usedPercent": int(item["used_pct"]) if item["used_pct"] is not None else None,
                "usedDetail": "of voucher time" if item["used_pct"] is not None else "",
            }
        )
    rows.sort(key=lambda row: (-1 if row["usedPercent"] is None else -row["usedPercent"]))
    router_states = {"surfing", "connected", "not_surfing", "expired", "suspended", "disconnecting", "disconnected", "pending_activation"}
    if status in router_states:
        rows = [row for row in rows if row["routerStatus"] == status]
    elif status in {"online", "offline"}:
        rows = [row for row in rows if row["connection"] == status]
    total = len(rows)
    return {
        "subscribers": rows[offset:offset + limit],
        "total": total,
        "limit": limit,
        "offset": offset,
        "routers": list_routers(cursor, client_id),
        "packages": [{"id": item["id"], "name": item["name"]} for item in cursor_packages(cursor, client_id)],
    }


def hotspot_usage(cursor, client_id, query):
    """Usage for hotspot guests — radacct is keyed by the hs- usernames.

    Each purchase's paying device surfs under h.username, and every redeemed
    voucher surfs under v.username; both join back to the purchase for the
    phone, router, and voucher code shown on the report.
    """
    mode, start, finish, granularity, label = usage_window(query or {})
    identities = """
        SELECT h.client_id, h.device_id, h.phone, v.username, v.code
        FROM hotspot_vouchers v
        JOIN hotspot_purchases h ON h.id = v.purchase_id
        WHERE h.deleted = 0
        UNION ALL
        SELECT h.client_id, h.device_id, h.phone, h.username, NULL AS code
        FROM hotspot_purchases h
        WHERE h.deleted = 0 AND h.username IS NOT NULL AND h.username <> ''
    """
    cursor.execute(
        f"""
        SELECT ids.username, ids.code, ids.phone, d.name AS router_name,
               COUNT(a.radacctid) AS sessions,
               COALESCE(SUM(a.acctinputoctets), 0) AS bytes_in,
               COALESCE(SUM(a.acctoutputoctets), 0) AS bytes_out
        FROM ({identities}) ids
        LEFT JOIN radacct a ON a.username = ids.username
            AND a.acctstarttime >= %s AND a.acctstarttime < %s
        LEFT JOIN isp_mikrotik_devices d ON d.id = ids.device_id
        WHERE ids.client_id = %s
        GROUP BY ids.username, ids.code, ids.phone, d.name
        ORDER BY (bytes_in + bytes_out) DESC, ids.username
        """,
        (start.isoformat(), finish.isoformat(), client_id),
    )
    clients = []
    range_in = 0
    range_out = 0
    for row in cursor.fetchall():
        download = int(row["bytes_in"] or 0)
        upload = int(row["bytes_out"] or 0)
        range_in += download
        range_out += upload
        clients.append(
            {
                "id": row["username"],
                "firstName": row["phone"] or "Hotspot guest",
                "lastName": "",
                "username": row["code"] or row["username"],
                "routerName": row["router_name"],
                "sessions": int(row["sessions"] or 0),
                "bytesIn": download,
                "bytesOut": upload,
            }
        )
    cursor.execute(
        f"""
        SELECT {USAGE_BUCKETS[granularity]} AS bucket, COALESCE(SUM(a.acctinputoctets), 0) AS bytes_in,
               COALESCE(SUM(a.acctoutputoctets), 0) AS bytes_out
        FROM radacct a
        JOIN ({identities}) ids ON ids.username = a.username
        WHERE ids.client_id = %s AND a.acctstarttime >= %s AND a.acctstarttime < %s
        GROUP BY {USAGE_BUCKETS[granularity]}
        ORDER BY bucket
        """,
        (client_id, start.isoformat(), finish.isoformat()),
    )
    return {
        "service": "hotspot",
        "view": usage_view(mode, start, finish, label),
        "clients": clients,
        "total": len(clients),
        "rangeBytesIn": range_in,
        "rangeBytesOut": range_out,
        "series": usage_series(cursor.fetchall(), start, finish, granularity),
    }


HOTSPOT_VALIDITY_SECONDS = {"hours": 3600, "days": 86400, "weeks": 604800, "months": 2592000}


def hotspot_client_row(cursor, client_id, purchase_id):
    cursor.execute(
        """
        SELECT h.id, h.client_id, h.device_id, h.package_id, h.phone, h.amount, h.checkout_id,
               h.mac, h.ip, h.devices, h.periods, h.username, h.password, h.status, h.authorized,
               h.mpesa_code, h.paid_at, h.created_at, h.deleted, h.ended_at,
               d.name AS router_name, d.tunnel_ip, d.api_secret,
               COALESCE(p.name, c.name, 'Wi-Fi bundle') AS package_name,
               COALESCE(p.validity_amount, c.validity_amount, 1) AS validity_amount,
               COALESCE(p.validity_unit, c.validity_unit, 'days') AS validity_unit,
               COALESCE(p.download_mbps, c.download_mbps, 0) AS download_mbps,
               COALESCE(p.upload_mbps, c.upload_mbps, 0) AS upload_mbps
        FROM hotspot_purchases h
        LEFT JOIN isp_mikrotik_devices d ON d.id = h.device_id
        LEFT JOIN isp_packages p ON p.id = h.package_id
        LEFT JOIN company_packages c ON c.id = p.company_package_id
        WHERE h.id = %s AND h.client_id = %s
        """,
        (str(purchase_id or "")[:36], client_id),
    )
    row = cursor.fetchone()
    if not row:
        raise PppoeError(404, "That hotspot client was not found.")
    return row


def hotspot_voucher_rows(cursor, purchase_id):
    cursor.execute(
        """
        SELECT id, code, username, password, seconds, status, redeemed_ip, redeemed_mac, issued_at, used_at
        FROM hotspot_vouchers WHERE purchase_id = %s ORDER BY issued_at, id
        """,
        (purchase_id,),
    )
    return cursor.fetchall()


def issue_hotspot_voucher_rows(cursor, row, count, seconds):
    """Mint single-use vouchers on a purchase. Same shape as the portal's issuer."""
    issued = []
    for _slot in range(max(1, int(count))):
        code = voucher_code()
        for _attempt in range(5):
            cursor.execute("SELECT id FROM hotspot_vouchers WHERE code = %s", (code,))
            if not cursor.fetchone():
                break
            code = voucher_code()
        voucher_id = str(uuid.uuid4())
        username = f"hs-{secrets.token_hex(4)}"
        secret = secrets.token_hex(4)
        cursor.execute(
            """
            INSERT INTO hotspot_vouchers
              (id, client_id, purchase_id, device_id, package_id, code, username, password, seconds)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                voucher_id, row["client_id"], row["id"], str(row.get("device_id") or "")[:36],
                str(row.get("package_id") or "")[:36], code, username, secret, int(seconds or 0),
            ),
        )
        issued.append({"id": voucher_id, "code": code, "username": username, "password": secret, "status": "issued"})
    return issued


def hotspot_usernames(row, vouchers):
    names = [voucher["username"] for voucher in vouchers if voucher.get("username")]
    if row.get("username"):
        names.append(row["username"])
    return names


def radacct_for_usernames(cursor, usernames, sql, extra_args=()):
    """Run a radacct query against a dynamic username IN (...) list."""
    if not usernames:
        return []
    marks = ", ".join(["%s"] * len(usernames))
    cursor.execute(sql.format(marks=marks), [*usernames, *extra_args])
    return cursor.fetchall()


def hotspot_client_detail(cursor, client_id, purchase_id):
    """Everything about one hotspot guest: purchase, vouchers, usage, timeline."""
    row = hotspot_client_row(cursor, client_id, purchase_id)
    vouchers = hotspot_voucher_rows(cursor, row["id"])
    usernames = hotspot_usernames(row, vouchers)
    labels = {voucher["username"]: voucher["code"] for voucher in vouchers}
    if row.get("username"):
        labels[row["username"]] = "This device"

    usage = {"bytesIn": 0, "bytesOut": 0, "sessions": 0, "firstSeen": None, "lastSeen": None}
    totals = radacct_for_usernames(
        cursor,
        usernames,
        f"""
        SELECT COALESCE(SUM(a.acctinputoctets), 0) AS bytes_in, COALESCE(SUM(a.acctoutputoctets), 0) AS bytes_out,
               COUNT(*) AS sessions, MIN(a.acctstarttime) AS first_seen, MAX(COALESCE(a.acctstoptime, a.acctstarttime)) AS last_seen
        FROM radacct a WHERE a.username IN ({{marks}})
        """,
    )
    if totals:
        usage = {
            "bytesIn": int(totals[0]["bytes_in"] or 0),
            "bytesOut": int(totals[0]["bytes_out"] or 0),
            "sessions": int(totals[0]["sessions"] or 0),
            "firstSeen": stamp(totals[0]["first_seen"]),
            "lastSeen": stamp(totals[0]["last_seen"]),
        }

    day_rows = radacct_for_usernames(
        cursor,
        usernames,
        f"""
        SELECT DATE(a.acctstarttime) AS day, COALESCE(SUM(a.acctinputoctets), 0) AS bytes_in,
               COALESCE(SUM(a.acctoutputoctets), 0) AS bytes_out
        FROM radacct a WHERE a.username IN ({{marks}}) AND a.acctstarttime >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
        GROUP BY DATE(a.acctstarttime) ORDER BY day
        """,
    )
    usage["days"] = [
        {"day": stamp(day["day"]), "bytesIn": int(day["bytes_in"]), "bytesOut": int(day["bytes_out"])}
        for day in day_rows
    ]

    open_sessions = radacct_for_usernames(
        cursor,
        usernames,
        "SELECT username FROM radacct a WHERE a.username IN ({marks}) AND a.acctstoptime IS NULL",
    )
    # Live view straight from the router — radacct only fills in when RADIUS
    # accounting is on, so /ip/hotspot/active is the source of truth for who
    # is actually surfing right now. /ip/hotspot/host adds the devices that
    # are on the network but have not logged in yet (connected, not surfing).
    live = []
    hosts = []
    router_reachable = False
    macs = [row.get("mac")] + [voucher["redeemed_mac"] for voucher in vouchers]
    mac_labels = {}
    if row.get("mac"):
        mac_labels[str(row["mac"]).upper()] = "This device"
    for voucher in vouchers:
        if voucher.get("redeemed_mac"):
            mac_labels[str(voucher["redeemed_mac"]).upper()] = voucher["code"]
    if row.get("tunnel_ip") and row.get("api_secret"):
        try:
            secret = routeros_api.open_password(row["api_secret"])
            live = routeros_api.hotspot_active_sessions(
                row["tunnel_ip"], secret, usernames=usernames, macs=macs
            )
            hosts = routeros_api.hotspot_hosts(row["tunnel_ip"], secret, macs=list(mac_labels))
            router_reachable = True
        except (routeros_api.RouterError, OSError):
            live = []
            hosts = []
    live_macs = {entry["mac"] for entry in live}
    hosts = [host for host in hosts if host["mac"] not in live_macs and not host["authorized"]]
    for host in hosts:
        host["label"] = mac_labels.get(host["mac"]) or host["mac"]
    for entry in live:
        entry["label"] = labels.get(entry["username"]) or entry["username"] or entry["mac"]
    sessions = radacct_for_usernames(
        cursor,
        usernames,
        f"""
        SELECT a.username, a.acctstarttime, a.acctstoptime, a.acctsessiontime,
               a.acctinputoctets, a.acctoutputoctets, a.framedipaddress, a.callingstationid, a.acctterminatecause
        FROM radacct a WHERE a.username IN ({{marks}})
        ORDER BY a.acctstarttime DESC LIMIT 20
        """,
    )

    timeline = []
    if row["created_at"]:
        timeline.append(
            {"at": stamp(row["created_at"]), "event": "Payment requested",
             "detail": f"M-Pesa prompt to {row['phone']} for {row['package_name']}."}
        )
    if row["paid_at"]:
        timeline.append(
            {"at": stamp(row["paid_at"]), "event": "Paid",
             "detail": f"KSh {format(Decimal(row['amount']), '.2f')} confirmed" + (f" — receipt {row['mpesa_code']}." if row.get("mpesa_code") else ".")}
        )
    elif row["status"] == "failed":
        timeline.append({"at": stamp(row["created_at"]), "event": "Payment failed", "detail": "M-Pesa did not confirm this request."})
    for voucher in vouchers:
        if voucher["issued_at"]:
            timeline.append({"at": stamp(voucher["issued_at"]), "event": "Voucher issued", "detail": voucher["code"]})
        if voucher["used_at"]:
            timeline.append(
                {"at": stamp(voucher["used_at"]), "event": "Voucher redeemed",
                 "detail": f"{voucher['code']} on {voucher['redeemed_mac'] or voucher['redeemed_ip'] or 'a device'}."}
            )
        if voucher["status"] == "void":
            timeline.append({"at": stamp(voucher["used_at"] or voucher["issued_at"]), "event": "Voucher voided", "detail": voucher["code"]})
    session_rows_out = []
    for session in sessions:
        live = session["acctstoptime"] is None
        session_rows_out.append(
            {
                "username": session["username"],
                "label": labels.get(session["username"]) or session["username"],
                "start": stamp(session["acctstarttime"]),
                "stop": stamp(session["acctstoptime"]),
                "seconds": int(session["acctsessiontime"] or 0),
                "bytesIn": int(session["acctinputoctets"] or 0),
                "bytesOut": int(session["acctoutputoctets"] or 0),
                "ip": session.get("framedipaddress") or "",
                "mac": session.get("callingstationid") or "",
                "cause": session.get("acctterminatecause") or "",
                "live": live,
            }
        )
        timeline.append(
            {"at": stamp(session["acctstarttime"]), "event": "Started surfing",
             "detail": f"{labels.get(session['username']) or session['username']} on {session.get('callingstationid') or 'a device'}."}
        )
        if session["acctstoptime"]:
            cause = session.get("acctterminatecause") or "session ended"
            timeline.append(
                {"at": stamp(session["acctstoptime"]), "event": "Dropped",
                 "detail": f"{labels.get(session['username']) or session['username']} — {str(cause).replace('-', ' ').lower()}."}
            )
    if row.get("ended_at"):
        timeline.append({"at": stamp(row["ended_at"]), "event": "Access ended", "detail": "Removed by the account operator."})
    timeline = [event for event in timeline if event["at"]]
    timeline.sort(key=lambda event: event["at"], reverse=True)

    return {
        "client": {
            "id": row["id"],
            "phone": row["phone"],
            "mac": row["mac"],
            "ip": row["ip"],
            "amount": format(Decimal(row["amount"]), ".2f"),
            "status": row["status"],
            "mpesaCode": row.get("mpesa_code") or "",
            "checkoutId": row["checkout_id"],
            "paidAt": stamp(row["paid_at"]),
            "createdAt": stamp(row["created_at"]),
            "packageName": row["package_name"],
            "routerName": row.get("router_name") or "",
            "devices": int(row["devices"] or 1),
            "periods": int(row["periods"] or 1),
            "username": row.get("username") or "",
            "authorized": bool(row["authorized"]),
            "endedAt": stamp(row.get("ended_at")),
            "deleted": bool(row.get("deleted")),
            "connection": "online" if (open_sessions or live) else "connected" if hosts else "offline",
        },
        "live": live,
        "hosts": hosts,
        "routerReachable": router_reachable,
        "vouchers": [
            {
                "id": voucher["id"],
                "code": voucher["code"],
                "username": voucher["username"],
                "password": voucher["password"],
                "seconds": int(voucher["seconds"] or 0),
                "status": voucher["status"],
                "redeemedIp": voucher["redeemed_ip"] or "",
                "redeemedMac": voucher["redeemed_mac"] or "",
                "issuedAt": stamp(voucher["issued_at"]),
                "usedAt": stamp(voucher["used_at"]),
            }
            for voucher in vouchers
        ],
        "usage": usage,
        "sessions": session_rows_out,
        "timeline": timeline,
    }


def hotspot_revoke_access(cursor, row, vouchers):
    """Kick live sessions, delete router hotspot users, and drop any RADIUS grants."""
    usernames = hotspot_usernames(row, vouchers)
    report = {"removed": 0, "dropped": 0}
    if usernames and row.get("tunnel_ip") and row.get("api_secret"):
        try:
            report = routeros_api.revoke_hotspot_client(
                row["tunnel_ip"], routeros_api.open_password(row["api_secret"]), usernames
            )
        except (routeros_api.RouterError, OSError):
            pass
    for name in usernames:
        try:
            coa_for(cursor, {"router_id": row["device_id"]}, name)
        except Exception:
            pass
        for table in ("radcheck", "radreply", "radusergroup"):
            cursor.execute(f"DELETE FROM {table} WHERE username = %s", (name,))
    return report


def hotspot_end_access(cursor, client_id, purchase_id):
    row = hotspot_client_row(cursor, client_id, purchase_id)
    vouchers = hotspot_voucher_rows(cursor, row["id"])
    report = hotspot_revoke_access(cursor, row, vouchers)
    cursor.execute(
        "UPDATE hotspot_vouchers SET status = 'void' WHERE purchase_id = %s AND status <> 'void'",
        (row["id"],),
    )
    cursor.execute(
        "UPDATE hotspot_purchases SET authorized = 0, ended_at = NOW() WHERE id = %s",
        (row["id"],),
    )
    return {"ended": True, "dropped": report.get("dropped", 0), "removed": report.get("removed", 0)}


def hotspot_recharge(cursor, client_id, purchase_id, payload):
    """Operator top-up: mint vouchers and put every connected registered device online.

    The buyer's MAC plus every MAC a voucher was redeemed on are checked
    against /ip/hotspot/host. Each device found there gets one of the fresh
    vouchers authorized against its live IP, so a manual recharge reconnects
    the whole account, not just the paying device.
    """
    row = hotspot_client_row(cursor, client_id, purchase_id)
    try:
        periods = min(60, max(1, int(payload.get("periods") or 1)))
        count = min(50, max(1, int(payload.get("vouchers") or 1)))
    except (TypeError, ValueError) as error:
        raise PppoeError(400, "Enter a valid number of vouchers and periods.") from error
    seconds = periods * HOTSPOT_VALIDITY_SECONDS.get(str(row["validity_unit"] or "days"), 86400) * int(row["validity_amount"] or 1)

    device_macs = []
    if row.get("mac"):
        device_macs.append(str(row["mac"]).upper())
    for voucher in hotspot_voucher_rows(cursor, row["id"]):
        mac = str(voucher.get("redeemed_mac") or "").upper()
        if mac and mac not in device_macs:
            device_macs.append(mac)
    live_hosts = {}
    secret = ""
    if row.get("tunnel_ip") and row.get("api_secret") and device_macs:
        try:
            secret = routeros_api.open_password(row["api_secret"])
            for host_row in routeros_api.hotspot_hosts(row["tunnel_ip"], secret, macs=device_macs, timeout=5):
                if not host_row["authorized"]:
                    live_hosts[host_row["mac"]] = host_row
        except (routeros_api.RouterError, OSError):
            live_hosts = {}

    count = max(count, min(50, len(live_hosts)))
    vouchers = issue_hotspot_voucher_rows(cursor, row, count, seconds)
    online = []
    if live_hosts and secret:
        profile = f"hs-{str(row['package_id'])[:8]}"
        rate = f"{int(row['upload_mbps'] or 0)}M/{int(row['download_mbps'] or 0)}M"
        slot = 0
        for mac in device_macs:
            host_row = live_hosts.get(mac)
            if not host_row or slot >= len(vouchers):
                continue
            voucher = vouchers[slot]
            try:
                grant = routeros_api.authorize_hotspot_client(
                    row["tunnel_ip"], secret,
                    host_row["ip"], mac, voucher["username"], voucher["password"],
                    profile, rate, 1, f"{max(1, seconds)}s",
                )
            except (routeros_api.RouterError, OSError):
                continue
            if not grant.get("online"):
                continue
            slot += 1
            online.append(mac)
            cursor.execute(
                """
                UPDATE hotspot_vouchers
                SET status = 'used', used_at = NOW(), redeemed_ip = %s, redeemed_mac = %s
                WHERE id = %s AND status = 'issued'
                """,
                (host_row["ip"], mac, voucher["id"]),
            )
            voucher["status"] = "used"
            if mac == str(row.get("mac") or "").upper() and host_row["ip"] and host_row["ip"] != (row.get("ip") or ""):
                cursor.execute("UPDATE hotspot_purchases SET ip = %s WHERE id = %s", (host_row["ip"], row["id"]))
    cursor.execute(
        "UPDATE hotspot_purchases SET authorized = 1, ended_at = NULL, status = 'paid', paid_at = COALESCE(paid_at, NOW()) WHERE id = %s",
        (row["id"],),
    )
    return {
        "vouchers": [{"code": voucher["code"], "status": voucher["status"]} for voucher in vouchers],
        "connected": len(online),
        "devices": online,
    }


def hotspot_delete(cursor, client_id, purchase_id):
    row = hotspot_client_row(cursor, client_id, purchase_id)
    vouchers = hotspot_voucher_rows(cursor, row["id"])
    hotspot_revoke_access(cursor, row, vouchers)
    cursor.execute("UPDATE hotspot_vouchers SET status = 'void' WHERE purchase_id = %s", (row["id"],))
    cursor.execute(
        "UPDATE hotspot_purchases SET authorized = 0, deleted = 1, ended_at = NOW() WHERE id = %s",
        (row["id"],),
    )
    return {"deleted": True}


def parse_daraja_callback(payload):
    """(checkout_id, result_code, description, receipt, phone) from a Daraja STK callback."""
    callback = ((payload or {}).get("Body") or {}).get("stkCallback") or {}
    checkout_id = str(callback.get("CheckoutRequestID") or "").strip()[:64]
    result_code = callback.get("ResultCode")
    description = str(callback.get("ResultDesc") or "").strip()
    receipt = ""
    phone = ""
    for item in ((callback.get("CallbackMetadata") or {}).get("Item") or []):
        name = str(item.get("Name") or "")
        if name == "MpesaReceiptNumber":
            receipt = str(item.get("Value") or "").strip()[:20]
        elif name == "PhoneNumber":
            phone = str(item.get("Value") or "").strip()[:20]
    return checkout_id, result_code, description, receipt, phone


def record_daraja_callback(cursor, payload):
    """Persist the real M-Pesa receipt code from a Daraja STK callback.

    The code lands on the STK request and the hotspot purchase, and any
    payment/invoice already written against the checkout id gets its
    reference rewritten so the billings page shows the M-Pesa code.
    """
    checkout_id, result_code, description, receipt, _phone = parse_daraja_callback(payload)
    if not checkout_id:
        raise PppoeError(400, "The callback did not include a checkout id.")
    if str(result_code) == "0" and receipt:
        cursor.execute("UPDATE pppoe_stk_requests SET mpesa_code = %s WHERE checkout_id = %s", (receipt, checkout_id))
        cursor.execute("UPDATE hotspot_purchases SET mpesa_code = %s WHERE checkout_id = %s", (receipt, checkout_id))
        # A request an earlier poll already marked failed can still be a real
        # payment when the PIN was entered late — revive it so the next status
        # poll credits it instead of reporting the stale failure.
        cursor.execute(
            "UPDATE pppoe_stk_requests SET status = 'pending', last_error = '' WHERE checkout_id = %s AND status = 'failed'",
            (checkout_id,),
        )
        cursor.execute(
            "UPDATE hotspot_purchases SET status = 'pending' WHERE checkout_id = %s AND status = 'failed'",
            (checkout_id,),
        )
        cursor.execute("UPDATE pppoe_payments SET mpesa_reference = %s WHERE mpesa_reference = %s", (receipt, checkout_id[:40]))
        cursor.execute("UPDATE pppoe_invoices SET mpesa_reference = %s WHERE mpesa_reference = %s", (receipt, checkout_id[:40]))
    elif str(result_code) != "0":
        reason = (description or "Payment was declined.")[:255]
        cursor.execute(
            "UPDATE pppoe_stk_requests SET status = 'failed', last_error = %s WHERE checkout_id = %s AND status = 'pending'",
            (reason, checkout_id),
        )
        cursor.execute(
            "UPDATE hotspot_purchases SET status = 'failed' WHERE checkout_id = %s AND status = 'pending'",
            (checkout_id,),
        )
    return {"checkoutId": checkout_id, "receipt": receipt, "resultCode": result_code}


def dispatch(cursor, method, path, payload, token, query):
    if path == "/api/routers" and method == "GET":
        return {"routers": list_routers(cursor, client_id_from(cursor, token))}, None
    if path.startswith("/api/routers/") and path.endswith("/packages") and method == "GET":
        router_id = path.removeprefix("/api/routers/").removesuffix("/packages").strip("/")
        client_id = client_id_from(cursor, token)
        return {"packages": packages_for_router(cursor, client_id, router_id)}, None
    if path == "/api/hotspot/subscribers" and method == "GET":
        return list_hotspot_clients(cursor, client_id_from(cursor, token), query), None
    if path == "/api/hotspot/usage" and method == "GET":
        return hotspot_usage(cursor, client_id_from(cursor, token), query), None
    hotspot_prefix = "/api/hotspot/clients/"
    if path.startswith(hotspot_prefix):
        client_id = client_id_from(cursor, token)
        purchase_id, _, action = path.removeprefix(hotspot_prefix).strip("/").partition("/")
        if method == "GET" and not action:
            return hotspot_client_detail(cursor, client_id, purchase_id), None
        if method == "POST" and action == "end-access":
            return {"result": hotspot_end_access(cursor, client_id, purchase_id)}, None
        if method == "POST" and action == "recharge":
            return {"result": hotspot_recharge(cursor, client_id, purchase_id, payload or {})}, None
        if method == "POST" and action == "delete":
            return {"result": hotspot_delete(cursor, client_id, purchase_id)}, None
        raise PppoeError(404, "That hotspot client was not found.")
    if path == "/api/billings/transactions" and method == "GET":
        return list_transactions(cursor, client_id_from(cursor, token), query), None
    if not path.startswith("/api/pppoe"):
        return None
    client_id = client_id_from(cursor, token)
    if path == "/api/pppoe/check-username" and method == "GET":
        return check_username(cursor, client_id, (query.get("u") or [""])[0]), None
    if path == "/api/pppoe/validate" and method == "POST":
        checked = pppoe_service.validate_pppoe_provisioning(payload, context_for(cursor, client_id, payload))
        checked["normalized"] = None if checked["errors"] else {key: value for key, value in checked["normalized"].items() if key != "password"}
        return checked, None
    if path == "/api/pppoe/usage" and method == "GET":
        return general_usage(cursor, client_id, "pppoe", query), None
    if path == "/api/pppoe/subscribers" and method == "GET":
        return list_subscribers(cursor, client_id, query, "pppoe"), None
    if path == "/api/pppoe/subscribers" and method == "POST":
        return {"subscriber": register_subscriber(cursor, client_id, payload)}, None
    if path == "/api/pppoe/jobs" and method == "POST":
        reconcile(cursor, client_id)
        return {"ok": True}, None
    prefix = "/api/pppoe/subscribers/"
    if not path.startswith(prefix):
        return None
    rest = path.removeprefix(prefix).strip("/")
    subscriber_id, _, action = rest.partition("/")
    if method == "GET" and not action:
        return {"subscriber": subscriber_detail(cursor, client_id, subscriber_id)}, None
    if method == "GET" and action == "sessions":
        return sessions_export(cursor, client_id, subscriber_id, query), None
    if method == "GET" and action == "usage":
        row = require_owned(cursor, client_id, subscriber_id)
        scale = str((query.get("range") or [""])[0])
        if scale in routeros_api.TREND_SCALES:
            return {"trend": usage_trend(cursor, row["pppoe_username"], scale)}, None
        return {"usage": usage_block(cursor, row["pppoe_username"])}, None
    if method == "GET" and action == "billing":
        row = require_owned(cursor, client_id, subscriber_id)
        return {"billing": billing_block(cursor, subscriber_id, row)}, None
    if method == "GET" and action == "status":
        row = require_owned(cursor, client_id, subscriber_id)
        live = current_session(cursor, row["pppoe_username"])
        label = pppoe_service.connection_label(int(row["open_sessions"] or 0), int(row["any_sessions"] or 0) > 0, row["tunnel_status"])
        rates = live_rates(cursor, row) if label == "online" else None
        devices = device_rows(cursor, row)
        return {"connection": label, "live": live, "status": row["status"], "billingStatus": row["billing_status"], "rates": rates, "devices": devices}, None
    if method != "POST":
        return None
    actions = {
        "renew": lambda: renew(cursor, client_id, subscriber_id, payload),
        "suspend": lambda: set_status(cursor, client_id, subscriber_id, "suspended", "suspended", str(payload.get("reason") or "Suspended."), False),
        "reactivate": lambda: reactivate(cursor, client_id, subscriber_id, payload),
        "upgrade": lambda: upgrade(cursor, client_id, subscriber_id, payload),
        "migrate": lambda: migrate(cursor, client_id, subscriber_id, payload),
        "disconnect": lambda: disconnect(cursor, client_id, subscriber_id, payload),
        "activate": lambda: activate(cursor, client_id, subscriber_id),
        "edit": lambda: edit_subscriber(cursor, client_id, subscriber_id, payload),
        "password": lambda: reset_password(cursor, client_id, subscriber_id, payload),
        "reveal": lambda: reveal_password(cursor, client_id, subscriber_id),
        "payment": lambda: record_payment(cursor, client_id, subscriber_id, payload),
        "delete": lambda: delete_subscriber(cursor, client_id, subscriber_id),
    }
    if action not in actions:
        return None
    if action == "suspend" and not str(payload.get("reason") or "").strip():
        raise PppoeError(400, "Enter a reason for the suspension.")
    result = actions[action]()
    if action == "reveal":
        return result, None
    return {"subscriber": result}, None
