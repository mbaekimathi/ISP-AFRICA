import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import portal_server
import routeros_api


class ScriptedSocket:
    def __init__(self, replies):
        self.replies = replies
        self.sent = []
        self.incoming = b""

    def sendall(self, payload):
        self.sent.append(payload)
        if self.replies:
            self.incoming += self.replies.pop(0)

    def recv(self, size):
        if not self.incoming:
            return b""
        chunk, self.incoming = self.incoming[:size], self.incoming[size:]
        return chunk

    def settimeout(self, _timeout):
        return None

    def close(self):
        return None


def sentence(*words):
    return routeros_api.encode_sentence(words)


def sock_with(rows=None, count=80):
    done = sentence("!done")
    replies = [done]
    if rows:
        replies.append(sentence("!re", *rows) + done)
    replies += [done] * count
    return ScriptedSocket(replies)


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows
        self.queries = []

    def execute(self, query, params=()):
        self.queries.append((query, params))

    def fetchall(self):
        return list(self.rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None


class HotspotRouterTests(unittest.TestCase):
    def test_hotspot_enable_writes_captive_portal(self):
        sock = sock_with(("=name=ether3", "=type=ether", "=comment=Hotspot"))
        report = routeros_api.apply_hotspot_access("10.88.0.5", "secret-password", True, opener=lambda _address, _timeout: sock)
        self.assertTrue(report["applied"])
        sent = b"".join(sock.sent)
        self.assertIn(b"/ip/hotspot/add", sent)
        self.assertIn(b"=profile=hotspot-profile", sent)
        self.assertIn(b"hotspot.local", sent)
        self.assertIn(b"=html-directory=isp-portal", sent)
        self.assertIn(b"/ip/hotspot/walled-garden/ip/add", sent)
        self.assertIn(b"dst-address=10.88.0.1", sent)
        self.assertIn(b"/tool/fetch", sent)
        self.assertIn(b"hotspot-page/login.html", sent)
        self.assertIn(b"=action=masquerade", sent)
        self.assertIn(b"isp-centric-portal-nat", sent)
        self.assertNotIn(b"/system/script", sent)

    def test_pppoe_off_writes_dhcp_portal(self):
        sock = sock_with(("=name=ether2", "=type=ether", "=comment=PPPoE"))
        report = routeros_api.apply_pppoe_enforcement("10.88.0.5", "secret-password", False, opener=lambda _address, _timeout: sock)
        self.assertTrue(report["applied"])
        sent = b"".join(sock.sent)
        self.assertIn(b"/ip/hotspot/add", sent)
        self.assertIn(b"dhcp-portal", sent)
        self.assertIn(b"portal.local", sent)
        self.assertIn(b"/tool/fetch", sent)
        self.assertIn(b"/ip/hotspot/walled-garden/ip/add", sent)
        self.assertNotIn(b"/system/script", sent)

    def test_portal_nat_skips_blocked_pppoe_users(self):
        sock = sock_with(("=name=ether2", "=type=ether", "=comment=PPPoE"))
        report = routeros_api.apply_pppoe_enforcement("10.88.0.5", "secret-password", True, opener=lambda _address, _timeout: sock)
        self.assertTrue(report["applied"])
        sent = b"".join(sock.sent)
        self.assertIn(b"isp-centric-portal-nat-skip", sent)
        self.assertIn(b"src-address-list=pppoe-expired", sent)
        self.assertIn(b"src-address-list=pppoe-suspended", sent)
        self.assertIn(b"isp-centric-portal-nat", sent)

    def test_authorize_writes_user_and_logs_in(self):
        sock = sock_with()
        report = routeros_api.authorize_hotspot_client(
            "10.88.0.5",
            "secret-password",
            "10.5.50.10",
            "AA:BB:CC:DD:EE:FF",
            "hs-abc123",
            "pw-xyz",
            "hs-pkg1",
            "5M/10M",
            2,
            "7200s",
            opener=lambda _address, _timeout: sock,
        )
        self.assertTrue(report["applied"])
        self.assertTrue(report["online"])
        sent = b"".join(sock.sent)
        self.assertIn(b"/ip/hotspot/user/profile/add", sent)
        self.assertIn(b"=name=hs-pkg1", sent)
        self.assertIn(b"=rate-limit=5M/10M", sent)
        self.assertIn(b"=shared-users=2", sent)
        self.assertIn(b"/ip/hotspot/user/add", sent)
        self.assertIn(b"=name=hs-abc123", sent)
        self.assertIn(b"=limit-uptime=7200s", sent)
        self.assertIn(b"/ip/hotspot/active/login", sent)
        self.assertIn(b"=ip=10.5.50.10", sent)
        self.assertIn(b"=mac-address=AA:BB:CC:DD:EE:FF", sent)
        self.assertNotIn(b"/system/script", sent)

    def test_authorize_rejects_unsafe_names(self):
        with self.assertRaises(routeros_api.RouterError):
            routeros_api.authorize_hotspot_client(
                "10.88.0.5", "secret-password", "10.5.50.10", "AA", "bad name!", "pw", "p", "", 1, "1h",
                opener=lambda _address, _timeout: sock_with(),
            )


class PortalHelperTests(unittest.TestCase):
    def test_validity_seconds(self):
        self.assertEqual(portal_server.validity_seconds(2, "hours"), 7200)
        self.assertEqual(portal_server.validity_seconds(1, "weeks"), 604800)
        self.assertEqual(portal_server.validity_seconds(30, "days"), 2592000)

    def test_router_pages(self):
        login = portal_server.router_page("login.html").decode()
        self.assertIn("/hotspot?login=", login)
        self.assertIn("$(link-login-only)", login)
        self.assertIn("$(mac-esc)", login)
        self.assertIn("$(error)", portal_server.router_page("error.html").decode())
        self.assertIn("$(link-orig)", portal_server.router_page("status.html").decode())
        self.assertIsNone(portal_server.router_page("evil.txt"))

    def test_hotspot_packages_filters_service_type_and_routers(self):
        rows = [
            {"id": "p1", "name": "Day pass", "price": "50.00", "download_mbps": 5, "upload_mbps": 5,
             "availability_routers": None, "service_type": "hotspot", "validity_amount": 1, "validity_unit": "days", "devices": 1},
            {"id": "p2", "name": "Monthly", "price": "1500.00", "download_mbps": 10, "upload_mbps": 10,
             "availability_routers": None, "service_type": "pppoe", "validity_amount": 1, "validity_unit": "months", "devices": 1},
            {"id": "p3", "name": "Other router", "price": "20.00", "download_mbps": 2, "upload_mbps": 2,
             "availability_routers": '["router-b"]', "service_type": "hotspot", "validity_amount": 6, "validity_unit": "hours", "devices": 1},
        ]
        offers = portal_server.hotspot_packages(FakeCursor(rows), "client-1", "router-a")
        self.assertEqual([offer["id"] for offer in offers], ["p1"])

    def test_login_url_carries_credentials(self):
        url = portal_server.hotspot_login_url(
            {"login": "http://10.5.50.1/login", "orig": "http://example.com/"},
            "hs-abc",
            "pw123",
        )
        self.assertTrue(url.startswith("http://10.5.50.1/login?"))
        self.assertIn("username=hs-abc", url)
        self.assertIn("password=pw123", url)
        self.assertIn("dst=http%3A%2F%2Fexample.com%2F", url)
        self.assertEqual(portal_server.hotspot_login_url({"login": "javascript:alert(1)"}, "u", "p"), "")
        self.assertEqual(portal_server.hotspot_login_url({"login": ""}, "u", "p"), "")


if __name__ == "__main__":
    unittest.main()
