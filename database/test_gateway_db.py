"""Integration tests for the gateway schema — NEEDS a live MySQL.

These run against a throwaway database (default ISP-DB-GWTEST, override with
ISP_GATEWAY_TEST_DB) using the same ISP_DB_* credentials as the app. The
database is dropped when the suite finishes. Everything is skipped when the
server cannot be reached, so offline runs stay green.
"""

import os
import sys
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import envfile

envfile.load()

import pymysql
from pymysql.cursors import DictCursor

import gateway_store

TEST_DB = os.environ.get("ISP_GATEWAY_TEST_DB", "ISP-DB-GWTEST")


def _connect(database=None, autocommit=True):
    return pymysql.connect(
        host=os.environ.get("ISP_DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("ISP_DB_PORT", "3306")),
        user=os.environ.get("ISP_DB_USER", "root"),
        password=os.environ.get("ISP_DB_PASSWORD", ""),
        database=database,
        charset="utf8mb4",
        autocommit=autocommit,
        cursorclass=DictCursor,
    )


def mysql_up():
    try:
        conn = _connect()
        conn.close()
        return True
    except pymysql.MySQLError:
        return False


def create_stubs(cursor):
    """The upstream tables gateway_store.ensure_schema/backfill rely on."""
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS isp_clients (
          id CHAR(36) NOT NULL PRIMARY KEY,
          status ENUM('pending', 'approved') NOT NULL DEFAULT 'approved'
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS isp_payment_settings (
          client_id CHAR(36) NOT NULL,
          scope ENUM('own', 'company') NOT NULL,
          consumer_key VARCHAR(128) NOT NULL DEFAULT '',
          consumer_secret VARCHAR(512) NOT NULL DEFAULT '',
          PRIMARY KEY (client_id, scope)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS company_daraja_settings (
          id TINYINT NOT NULL PRIMARY KEY,
          environment ENUM('sandbox', 'live') NOT NULL,
          account_type ENUM('paybill', 'till') NOT NULL,
          short_code VARCHAR(10) NOT NULL,
          consumer_key VARCHAR(128) NOT NULL,
          consumer_secret VARCHAR(512) NOT NULL,
          passkey VARCHAR(512) NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        "INSERT INTO company_daraja_settings (id, environment, account_type, short_code, consumer_key, consumer_secret, passkey) VALUES (1, 'sandbox', 'paybill', '600000', 'k', 's', 'p') ON DUPLICATE KEY UPDATE id = id"
    )


NEW_TABLES = (
    "isp_payout_settings",
    "gateway_payments",
    "settlement_batches",
    "gateway_ledger_entries",
    "settlement_batch_entries",
    "gateway_payouts",
    "gateway_callback_events",
    "gateway_audit_log",
    "gateway_notifications",
)


@unittest.skipUnless(mysql_up(), "MySQL is not reachable — live schema tests skipped")
class GatewaySchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin = _connect()
        with cls.admin.cursor() as cursor:
            cursor.execute(f"CREATE DATABASE IF NOT EXISTS `{TEST_DB}` CHARACTER SET utf8mb4")
        cls.db = _connect(TEST_DB)
        with cls.db.cursor() as cursor:
            create_stubs(cursor)
            gateway_store.ensure_schema(cursor)

    @classmethod
    def tearDownClass(cls):
        try:
            with cls.admin.cursor() as cursor:
                cursor.execute(f"DROP DATABASE IF EXISTS `{TEST_DB}`")
        finally:
            cls.db.close()
            cls.admin.close()

    def setUp(self):
        with self.db.cursor() as cursor:
            for table in NEW_TABLES:
                # gateway_ledger_entries is append-only by trigger — leftover
                # rows are harmless: every fixture writes unique uuids.
                if table == "gateway_ledger_entries":
                    continue
                cursor.execute(f"DELETE FROM {table}")

    def _tables(self):
        with self.db.cursor() as cursor:
            cursor.execute("SHOW TABLES")
            return {list(row.values())[0] for row in cursor.fetchall()}

    def test_ensure_is_idempotent(self):
        with self.db.cursor() as cursor:
            gateway_store.ensure_schema(cursor)
            gateway_store.ensure_schema(cursor)
        missing = [name for name in NEW_TABLES if name not in self._tables()]
        self.assertEqual(missing, [])

    def test_undo_then_reapply(self):
        with self.db.cursor() as cursor:
            for statement in gateway_store.UNDO_STATEMENTS:
                cursor.execute(statement)
        self.assertFalse(set(NEW_TABLES) & self._tables())
        with self.db.cursor() as cursor:
            cursor.execute("SHOW COLUMNS FROM company_daraja_settings LIKE 'callback_secret_enc'")
            self.assertIsNone(cursor.fetchone())
            gateway_store.ensure_schema(cursor)
        missing = [name for name in NEW_TABLES if name not in self._tables()]
        self.assertEqual(missing, [])
        with self.db.cursor() as cursor:
            cursor.execute("SHOW COLUMNS FROM company_daraja_settings LIKE 'callback_secret_enc'")
            self.assertIsNotNone(cursor.fetchone())

    def _insert_ledger(self, payment_id=None, payout_id=None, kind="collection"):
        entry = str(uuid.uuid4())
        with self.db.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO gateway_ledger_entries
                  (id, client_id, payment_id, payout_id, type, amount, balance_after)
                VALUES (%s, 'c1', %s, %s, %s, 10.00, 10.00)
                """,
                (entry, payment_id, payout_id, kind),
            )
        return entry

    def test_ledger_update_is_blocked(self):
        entry = self._insert_ledger()
        with self.assertRaises(pymysql.MySQLError):
            with self.db.cursor() as cursor:
                cursor.execute(
                    "UPDATE gateway_ledger_entries SET amount = 1 WHERE id = %s", (entry,)
                )

    def test_ledger_delete_is_blocked(self):
        entry = self._insert_ledger()
        with self.assertRaises(pymysql.MySQLError):
            with self.db.cursor() as cursor:
                cursor.execute("DELETE FROM gateway_ledger_entries WHERE id = %s", (entry,))

    def test_ledger_collection_is_once_per_payment(self):
        payment = str(uuid.uuid4())
        self._insert_ledger(payment_id=payment)
        with self.assertRaises(pymysql.MySQLError):
            self._insert_ledger(payment_id=payment)

    def test_payment_receipt_and_checkout_are_unique(self):
        receipt, checkout = "QAB123", "ws_CO_1"
        with self.db.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO gateway_payments
                  (id, client_id, channel, amount, mpesa_receipt, checkout_id)
                VALUES (%s, 'c1', 'stk', 1.00, %s, %s)
                """,
                (str(uuid.uuid4()), receipt, checkout),
            )
            with self.assertRaises(pymysql.MySQLError):
                cursor.execute(
                    """
                    INSERT INTO gateway_payments
                      (id, client_id, channel, amount, mpesa_receipt, checkout_id)
                    VALUES (%s, 'c1', 'stk', 1.00, %s, 'ws_CO_other')
                    """,
                    (str(uuid.uuid4()), receipt),
                )
            with self.assertRaises(pymysql.MySQLError):
                cursor.execute(
                    """
                    INSERT INTO gateway_payments
                      (id, client_id, channel, amount, mpesa_receipt, checkout_id)
                    VALUES (%s, 'c1', 'stk', 1.00, 'QXX999', %s)
                    """,
                    (str(uuid.uuid4()), checkout),
                )

    def test_payout_idempotency_key_is_unique(self):
        with self.db.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO gateway_payouts
                  (id, batch_id, client_id, destination_type, destination_value, amount, idempotency_key)
                VALUES ('p1', 'b1', 'c1', 'phone', '254700000000', 5.00, 'idem-1')
                """
            )
            with self.assertRaises(pymysql.MySQLError):
                cursor.execute(
                    """
                    INSERT INTO gateway_payouts
                      (id, batch_id, client_id, destination_type, destination_value, amount, idempotency_key)
                    VALUES ('p2', 'b1', 'c1', 'phone', '254700000000', 5.00, 'idem-1')
                    """
                )

    def test_get_lock_excludes_a_second_holder(self):
        other = _connect(TEST_DB)
        try:
            with self.db.cursor() as cursor:
                cursor.execute("SELECT GET_LOCK('isp-settlement-test', 0) AS got")
                self.assertEqual(int(cursor.fetchone()["got"]), 1)
            with other.cursor() as cursor:
                cursor.execute("SELECT GET_LOCK('isp-settlement-test', 0) AS got")
                self.assertNotEqual(int(cursor.fetchone()["got"] or 0), 1)
            with self.db.cursor() as cursor:
                cursor.execute("SELECT RELEASE_LOCK('isp-settlement-test')")
        finally:
            other.close()

    def test_for_update_row_lock(self):
        with self.db.cursor() as cursor:
            cursor.execute(
                "INSERT INTO isp_payout_settings (client_id, gateway_mode) VALUES ('lock-me', 'own_daraja')"
            )
        tx1 = _connect(TEST_DB, autocommit=False)
        tx2 = _connect(TEST_DB, autocommit=False)
        try:
            with tx1.cursor() as cursor:
                cursor.execute(
                    "SELECT client_id FROM isp_payout_settings WHERE client_id = 'lock-me' FOR UPDATE"
                )
            with self.assertRaises(pymysql.MySQLError):
                with tx2.cursor() as cursor:
                    cursor.execute(
                        "SELECT client_id FROM isp_payout_settings WHERE client_id = 'lock-me' FOR UPDATE NOWAIT"
                    )
        finally:
            tx1.rollback()
            tx2.rollback()
            tx1.close()
            tx2.close()

    def test_backfill_modes(self):
        with self.db.cursor() as cursor:
            cursor.executemany(
                "INSERT INTO isp_clients (id) VALUES (%s)",
                [("with-own",), ("with-company",), ("with-none",)],
            )
            cursor.execute(
                "INSERT INTO isp_payment_settings (client_id, scope, consumer_key, consumer_secret) VALUES ('with-own', 'own', 'k', 's')"
            )
            cursor.execute(
                "INSERT INTO isp_payment_settings (client_id, scope, consumer_key, consumer_secret) VALUES ('with-company', 'company', 'k', 's')"
            )
            gateway_store.backfill_gateway_modes(cursor)
            cursor.execute(
                "SELECT client_id, gateway_mode FROM isp_payout_settings WHERE client_id IN ('with-own', 'with-company', 'with-none')"
            )
            modes = {row["client_id"]: row["gateway_mode"] for row in cursor.fetchall()}
        # Any stored credential keeps collecting the way it did before the
        # switch — pooled custody is opt-in only, never backfilled.
        self.assertEqual(modes["with-own"], "own_daraja")
        self.assertEqual(modes["with-company"], "own_daraja")
        self.assertEqual(modes["with-none"], "none")
        # Re-running never overwrites an existing row.
        with self.db.cursor() as cursor:
            cursor.execute(
                "UPDATE isp_payout_settings SET gateway_mode = 'company_gateway' WHERE client_id = 'with-own'"
            )
            gateway_store.backfill_gateway_modes(cursor)
            cursor.execute(
                "SELECT gateway_mode FROM isp_payout_settings WHERE client_id = 'with-own'"
            )
            self.assertEqual(cursor.fetchone()["gateway_mode"], "company_gateway")


if __name__ == "__main__":
    unittest.main()
