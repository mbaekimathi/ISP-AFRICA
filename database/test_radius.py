import hashlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import radius_server

SECRET = "testing-secret"
USERNAME = "0722123456"
PASSWORD = "Abcdefg2"
REQUEST_AUTH = bytes(range(16))


def encode_pap(secret, request_auth, password):
    plain = password.encode()
    plain += b"\x00" * (16 - len(plain) % 16)
    out = b""
    previous = request_auth
    for offset in range(0, len(plain), 16):
        block = plain[offset: offset + 16]
        digest = hashlib.md5(secret.encode() + previous).digest()
        cipher = bytes(left ^ right for left, right in zip(digest, block))
        out += cipher
        previous = cipher
    return out


def chap_packet(password, challenge):
    ident = 7
    digest = hashlib.md5(bytes([ident]) + password.encode() + challenge).digest()
    return {
        "id": 1,
        "auth": REQUEST_AUTH,
        "attrs": {1: [USERNAME.encode()], 3: [bytes([ident]) + digest], 60: [challenge]},
        "vendor": {},
    }


def pap_packet(password):
    return {
        "id": 1,
        "auth": REQUEST_AUTH,
        "attrs": {1: [USERNAME.encode()], 2: [encode_pap(SECRET, REQUEST_AUTH, password)]},
        "vendor": {},
    }


def mschap1_packet(password, challenge):
    nt_response = radius_server.challenge_response(challenge[:8], radius_server.nt_hash(password))
    response = bytes([5, 1]) + bytes(24) + nt_response
    return {
        "id": 1,
        "auth": REQUEST_AUTH,
        "attrs": {1: [USERNAME.encode()]},
        "vendor": {radius_server.VENDOR_MICROSOFT: [(radius_server.MS_CHAP_CHALLENGE, challenge), (radius_server.MS_CHAP_RESPONSE, response)]},
    }


class FakeCursor:
    """Answers the queries authenticate() runs. update_closed flips open_count to zero."""

    def __init__(self, open_count=0, cleartext=PASSWORD, sessions=None):
        self.open_count = open_count
        self.cleartext = cleartext
        self.sessions = sessions or []
        self.updated = False
        self.queries = []

    def execute(self, sql, args=None):
        normalized = " ".join(sql.split())
        if normalized.startswith("UPDATE radacct"):
            self.open_count = 0
            self.updated = True
        self.last = normalized
        self.queries.append((normalized, args))

    def fetchone(self):
        sql = getattr(self, "last", "")
        if sql.startswith("SELECT secret FROM nas"):
            return {"secret": SECRET}
        if sql.startswith("SELECT router_id FROM pppoe_subscribers"):
            router = getattr(self, "subscriber_router", None)
            return {"router_id": router} if router else None
        if "open_count" in sql:
            return {"open_count": self.open_count}
        return None

    def fetchall(self):
        sql = getattr(self, "last", "")
        if sql.startswith("SELECT username, attribute, value FROM radcheck"):
            if not self.cleartext:
                return []
            return [
                {"username": USERNAME, "attribute": "Cleartext-Password", "value": self.cleartext},
                {"username": USERNAME, "attribute": "Simultaneous-Use", "value": "1"},
            ]
        if sql.startswith("SELECT radacctid"):
            return list(self.sessions)
        if "FROM isp_radius_nas" in sql:
            router = getattr(self, "nas_router", None)
            return [{"router_id": router}] if router else []
        return []


class VerifyPasswordTests(unittest.TestCase):
    def test_pap_accepts_and_rejects(self):
        ok, _ = radius_server.verify_password(pap_packet(PASSWORD), SECRET, PASSWORD)
        self.assertTrue(ok)
        ok, _ = radius_server.verify_password(pap_packet("wrongpw99"), SECRET, PASSWORD)
        self.assertFalse(ok)

    def test_chap_accepts_and_rejects(self):
        challenge = b"chapchal"
        ok, _ = radius_server.verify_password(chap_packet(PASSWORD, challenge), SECRET, PASSWORD)
        self.assertTrue(ok)
        ok, _ = radius_server.verify_password(chap_packet("wrongpw99", challenge), SECRET, PASSWORD)
        self.assertFalse(ok)

    def test_mschap1_reads_the_nt_response_field(self):
        challenge = bytes(range(16, 32))
        ok, _ = radius_server.verify_password(mschap1_packet(PASSWORD, challenge), SECRET, PASSWORD)
        self.assertTrue(ok)
        ok, _ = radius_server.verify_password(mschap1_packet("wrongpw99", challenge), SECRET, PASSWORD)
        self.assertFalse(ok)


class AuthenticateTests(unittest.TestCase):
    def test_valid_login_is_accepted(self):
        response = radius_server.authenticate(FakeCursor(), pap_packet(PASSWORD), "10.88.0.2")
        self.assertEqual(response[0], radius_server.ACCESS_ACCEPT)

    def test_wrong_password_is_rejected(self):
        response = radius_server.authenticate(FakeCursor(), pap_packet("wrongpw99"), "10.88.0.2")
        self.assertEqual(response[0], radius_server.ACCESS_REJECT)

    def test_unknown_username_is_rejected(self):
        response = radius_server.authenticate(FakeCursor(cleartext=""), pap_packet(PASSWORD), "10.88.0.2")
        self.assertEqual(response[0], radius_server.ACCESS_REJECT)

    def test_stale_open_session_is_closed_before_the_simultaneous_check(self):
        cursor = FakeCursor(open_count=1)
        response = radius_server.authenticate(cursor, pap_packet(PASSWORD), "10.88.0.2")
        self.assertTrue(cursor.updated)
        self.assertEqual(response[0], radius_server.ACCESS_ACCEPT)

    def test_busy_account_closes_the_dead_session_without_a_disconnect_request(self):
        # The auth path never PoDs — a radacct row is only a guess, and a stale
        # Acct-Session-Id can collide with a live session after a NAS reboot.
        cursor = FakeCursor(
            open_count=1,
            sessions=[
                {
                    "radacctid": 7,
                    "username": USERNAME,
                    "nasipaddress": "10.88.0.2",
                    "acctsessionid": "session-1",
                    "framedipaddress": "10.10.0.5",
                }
            ],
        )
        response = radius_server.authenticate(cursor, pap_packet(PASSWORD), "10.88.0.2")
        self.assertEqual(response[0], radius_server.ACCESS_ACCEPT)
        self.assertTrue(cursor.updated)

    def test_realm_suffix_matches_the_base_username(self):
        packet = pap_packet(PASSWORD)
        packet["attrs"][1] = [f"{USERNAME}@isp".encode()]
        cursor = FakeCursor()
        response = radius_server.authenticate(cursor, packet, "10.88.0.2")
        self.assertEqual(response[0], radius_server.ACCESS_ACCEPT)
        radcheck_args = [args for sql, args in cursor.queries if sql.startswith("SELECT username, attribute, value FROM radcheck")]
        self.assertTrue(any(USERNAME in (args or []) for args in radcheck_args))

    def test_credential_dialed_on_another_router_is_rejected(self):
        cursor = FakeCursor()
        cursor.subscriber_router = "router-a"
        cursor.nas_router = "router-b"
        response = radius_server.authenticate(cursor, pap_packet(PASSWORD), "10.88.0.9")
        self.assertEqual(response[0], radius_server.ACCESS_REJECT)

    def test_credential_on_its_own_router_is_accepted(self):
        cursor = FakeCursor()
        cursor.subscriber_router = "router-a"
        cursor.nas_router = "router-a"
        response = radius_server.authenticate(cursor, pap_packet(PASSWORD), "10.88.0.2")
        self.assertEqual(response[0], radius_server.ACCESS_ACCEPT)

    def test_wrong_router_attempt_does_not_touch_the_live_session(self):
        cursor = FakeCursor(
            open_count=1,
            sessions=[
                {
                    "radacctid": 7,
                    "username": USERNAME,
                    "nasipaddress": "10.88.0.2",
                    "acctsessionid": "session-1",
                    "framedipaddress": "10.10.0.5",
                }
            ],
        )
        cursor.subscriber_router = "router-a"
        cursor.nas_router = "router-b"
        response = radius_server.authenticate(cursor, pap_packet(PASSWORD), "10.88.0.9")
        self.assertEqual(response[0], radius_server.ACCESS_REJECT)
        self.assertFalse(cursor.updated)

    def test_radius_user_without_a_subscriber_row_still_authenticates(self):
        cursor = FakeCursor()
        cursor.nas_router = "router-b"
        response = radius_server.authenticate(cursor, pap_packet(PASSWORD), "10.88.0.9")
        self.assertEqual(response[0], radius_server.ACCESS_ACCEPT)

    def test_unknown_nas_is_dropped_silently(self):
        class EmptyNas(FakeCursor):
            def fetchone(self):
                sql = getattr(self, "last", "")
                if sql.startswith("SELECT secret FROM nas"):
                    return None
                return super().fetchone()

        self.assertIsNone(radius_server.authenticate(EmptyNas(), pap_packet(PASSWORD), "203.0.113.9"))


def accounting_packet(status, session_id, nas_ip="10.88.0.10"):
    import socket
    import struct

    attrs = (
        radius_server.encode_attr(40, struct.pack(">I", status))
        + radius_server.encode_attr(44, session_id.encode())
        + radius_server.encode_attr(1, USERNAME.encode())
        + radius_server.encode_attr(4, socket.inet_aton(nas_ip))
    )
    head = struct.pack(">BBH", 4, 7, 20 + len(attrs))
    auth = hashlib.md5(head + bytes(16) + attrs + SECRET.encode()).digest()
    return radius_server.parse_packet(head + auth + attrs)


class AccountingScopeTests(unittest.TestCase):
    """Acct-Session-Id restarts per router, so radacct writes must be scoped by NAS."""

    def setUp(self):
        radius_server.nas_cache_clear()

    def radacct_writes(self, status):
        cursor = FakeCursor()
        cursor.rowcount = 1
        radius_server.accounting(cursor, accounting_packet(status, "81a00001"), "10.88.0.10")
        return [(sql, args) for sql, args in cursor.queries if sql.startswith("UPDATE radacct SET")]

    def test_start_only_closes_rows_on_the_same_nas(self):
        writes = self.radacct_writes(radius_server.STATUS_START)
        self.assertEqual(len(writes), 1)
        self.assertIn("nasipaddress = %s", writes[0][0])
        self.assertEqual(writes[0][1], ("81a00001", "10.88.0.10"))

    def test_interim_only_updates_rows_on_the_same_nas(self):
        writes = self.radacct_writes(radius_server.STATUS_INTERIM)
        self.assertEqual(len(writes), 1)
        self.assertIn("acctsessionid = %s AND nasipaddress = %s", writes[0][0])
        self.assertEqual(writes[0][1][-2:], ("81a00001", "10.88.0.10"))


if __name__ == "__main__":
    unittest.main()
