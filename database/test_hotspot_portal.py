import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from unittest import mock

import api
import portal_server
import pppoe_store
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


def rule_sock(rules):
    """Replies !re rows to every command whose sentence contains the marker."""

    class RuleSocket(ScriptedSocket):
        def __init__(self):
            super().__init__([])
            self.rules = [(marker.encode(), words) for marker, words in rules]

        def sendall(self, payload):
            self.sent.append(payload)
            for marker, words in self.rules:
                if marker in payload:
                    self.incoming += sentence("!re", *words)
            self.incoming += sentence("!done")

    return RuleSocket()


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


class HsVoucherCursor:
    """Minimal fake covering the hotspot_vouchers queries the portal runs."""

    def __init__(self):
        self.vouchers = {}
        self.rowcount = 0
        self._result = []
        self.statements = []

    def execute(self, sql, args=None):
        args = list(args or [])
        flat = " ".join(sql.split())
        self.statements.append(flat)
        self._result = []
        if flat.startswith("UPDATE hotspot_vouchers"):
            self.rowcount = 0
            if "username IN" in flat:
                wanted = set(args)
                for voucher in self.vouchers.values():
                    if voucher["status"] == "issued" and voucher["username"] in wanted:
                        voucher["status"] = "used"
                        self.rowcount += 1
            else:
                target = self.vouchers.get(args[-1])
                self.rowcount = 0
                if target and target["status"] == "issued":
                    target["status"] = "used"
                    self.rowcount = 1
        elif flat.startswith("INSERT INTO hotspot_vouchers"):
            vid, client_id, purchase_id, device_id, package_id, code, username, secret, seconds = args
            self.vouchers[vid] = {
                "id": vid,
                "purchase_id": purchase_id,
                "code": code,
                "username": username,
                "password": secret,
                "seconds": seconds,
                "status": "issued",
            }
        elif flat.startswith("SELECT id FROM hotspot_vouchers WHERE code"):
            self._result = [{"id": v["id"]} for v in self.vouchers.values() if v["code"] == args[0]]
        elif flat.startswith("SELECT id, code, username, password, status FROM hotspot_vouchers"):
            self._result = [v for v in self.vouchers.values() if v["purchase_id"] == args[0]]
        elif flat.startswith("SELECT code, status FROM hotspot_vouchers"):
            self._result = [
                {"code": v["code"], "status": v["status"]}
                for v in self.vouchers.values()
                if v["purchase_id"] == args[0]
            ]

    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return list(self._result)


def pending_purchase(**extra):
    pending = {
        "purchase_id": "pu-1",
        "client_id": "client-1",
        "device_id": "router-1",
        "package_id": "pkg-1",
        "seconds": 86400,
        "devices": 2,
        "ip": "10.5.50.10",
        "mac": "AA:BB:CC:DD:EE:FF",
    }
    pending.update(extra)
    return pending


class HotspotRouterTests(unittest.TestCase):
    def test_block_sharing_adds_ttl_rule_on_enable(self):
        sock = sock_with(("=name=ether3", "=type=ether", "=comment=Hotspot"))
        routeros_api.apply_hotspot_access(
            "10.88.0.5", "secret-password", True, block_sharing=True, opener=lambda _address, _timeout: sock
        )
        sent = b"".join(sock.sent)
        self.assertIn(b"/ip/firewall/mangle/add", sent)
        self.assertIn(b"=new-ttl=set:1", sent)
        self.assertIn(b"=chain=postrouting", sent)
        self.assertIn(routeros_api.HOTSPOT_NO_SHARE.encode(), sent)

    def test_sharing_left_alone_when_not_chosen(self):
        sock = sock_with(("=name=ether3", "=type=ether", "=comment=Hotspot"))
        routeros_api.apply_hotspot_access("10.88.0.5", "secret-password", True, opener=lambda _address, _timeout: sock)
        self.assertNotIn(b"/ip/firewall/mangle", b"".join(sock.sent))

    def test_allow_sharing_removes_the_rule(self):
        done = sentence("!done")
        rows = sentence("!re", "=.id=*9", "=out-interface=ether3", "=new-ttl=set:1", f"=comment={routeros_api.HOTSPOT_NO_SHARE}")
        sock = ScriptedSocket([rows + done, done])
        routeros_api._hotspot_sharing(sock, routeros_api.ByteReader(sock), "ether3", False)
        sent = b"".join(sock.sent)
        self.assertIn(b"/ip/firewall/mangle/remove", sent)
        self.assertIn(b"=.id=*9", sent)
        self.assertNotIn(b"/ip/firewall/mangle/add", sent)

    def test_block_sharing_keeps_a_matching_rule(self):
        done = sentence("!done")
        rows = (
            sentence("!re", "=.id=*9", "=out-interface=ether3", "=new-ttl=set:1", f"=comment={routeros_api.HOTSPOT_NO_SHARE}")
            + sentence("!re", "=.id=*8", "=out-interface=ether9", "=new-ttl=set:1", f"=comment={routeros_api.HOTSPOT_NO_SHARE}")
        )
        sock = ScriptedSocket([rows + done, done, done])
        routeros_api._hotspot_sharing(sock, routeros_api.ByteReader(sock), "ether3", True)
        sent = b"".join(sock.sent)
        self.assertIn(b"=.id=*8", sent)
        self.assertNotIn(b"=.id=*9", sent)
        self.assertNotIn(b"/ip/firewall/mangle/add", sent)

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

    def test_portal_nat_netmaps_blocked_users_into_the_router_block(self):
        sock = sock_with(("=name=ether2", "=type=ether", "=comment=PPPoE"))
        sock.getpeername = lambda: ("10.88.0.5", 8728)
        routeros_api.apply_pppoe_enforcement("10.88.0.5", "secret-password", True, opener=lambda _address, _timeout: sock)
        sent = b"".join(sock.sent)
        self.assertIn(b"=action=netmap", sent)
        self.assertIn(b"=to-addresses=10.89.5.0/24", sent)

    def test_identify_reads_router_and_host_from_a_netmapped_visitor(self):
        class Cursor:
            def __init__(self):
                self.calls = []

            def execute(self, sql, params):
                self.calls.append((sql, params))

            def fetchall(self):
                return []

            def fetchone(self):
                return None

        cursor = Cursor()
        portal_server.identify(cursor, "10.89.5.37")
        self.assertIn("r.nasipaddress = %s AND r.framedipaddress LIKE %s", cursor.calls[0][0])
        self.assertEqual(cursor.calls[0][1], ("10.88.0.5", "%.37"))
        cursor = Cursor()
        portal_server.identify(cursor, "10.10.0.37")
        self.assertEqual(cursor.calls[0][1], ("10.10.0.37",))

    def test_pppoe_off_hardens_gate_and_drops_ipv6(self):
        # The dhcp-portal must not leave free paths open: an empty-password
        # hotspot user, a bypassed ip-binding, and an accept-all walled garden
        # all have to go, and IPv6 on the captive interface must be dropped —
        # the RouterOS hotspot only intercepts IPv4.
        sock = rule_sock(
            [
                ("/interface/print", ("=name=ether2", "=type=ether", "=comment=PPPoE")),
                ("/ip/hotspot/profile/print", ("=name=hsprof1", "=.id=*4", "=login-by=http-pap,trial")),
                ("/ip/hotspot/user/print", ("=name=admin", "=.id=*2")),
                ("/ip/hotspot/ip-binding/print", ("=address=10.10.0.9", "=type=bypassed", "=.id=*7")),
                ("/ip/hotspot/walled-garden/ip/print", ("=action=accept", "=dst-address=0.0.0.0/0", "=.id=*9")),
            ]
        )
        report = routeros_api.apply_pppoe_enforcement(
            "10.88.0.5", "secret-password", False, opener=lambda _address, _timeout: sock
        )
        self.assertTrue(report["applied"])
        sent = b"".join(sock.sent)
        self.assertIn(b"/ip/hotspot/add", sent)
        self.assertIn(b"dhcp-portal", sent)
        self.assertIn(b"/ip/hotspot/user/remove", sent)
        self.assertIn(b"/ip/hotspot/ip-binding/remove", sent)
        self.assertIn(b"/ip/hotspot/walled-garden/ip/remove", sent)
        self.assertIn(b"=login-by=http-pap", sent)
        self.assertNotIn(b"trial", sent)
        self.assertIn(b"/ipv6/firewall/filter/add", sent)
        self.assertIn(b"isp-centric-hotspot-drop-v6", sent)

    def test_pppoe_off_refuses_when_device_mode_blocks_hotspot(self):
        sock = rule_sock(
            [
                ("/interface/print", ("=name=ether2", "=type=ether", "=comment=PPPoE")),
                ("/system/device-mode/print", ("=hotspot=no",)),
            ]
        )
        with self.assertRaises(routeros_api.RouterError) as raised:
            routeros_api.apply_pppoe_enforcement(
                "10.88.0.5", "secret-password", False, opener=lambda _address, _timeout: sock
            )
        self.assertIn("device-mode", str(raised.exception))
        self.assertNotIn(b"/ip/hotspot/add", b"".join(sock.sent))

    def test_port_plan_hotspot_use_hardens_and_drops_ipv6(self):
        sock = rule_sock(
            [
                ("/interface/print", ("=name=ether3", "=type=ether")),
                ("/interface/bridge/port/print", ("=interface=ether3", "=bridge=bridge1", "=.id=*1")),
                ("/ip/hotspot/user/print", ("=name=admin", "=.id=*2")),
            ]
        )
        report = routeros_api.apply_port_uses(
            "10.88.0.5", "secret-password", {"ether3": ["hotspot"]}, opener=lambda _address, _timeout: sock
        )
        self.assertTrue(report["applied"])
        sent = b"".join(sock.sent)
        self.assertIn(b"/ip/hotspot/add", sent)
        self.assertIn(b"=interface=bridge1", sent)
        self.assertIn(b"/ip/hotspot/user/remove", sent)
        self.assertIn(b"/ipv6/firewall/filter/add", sent)
        self.assertIn(b"isp-centric-hotspot-drop-v6", sent)

    def test_port_plan_without_hotspot_clears_the_v6_drop(self):
        sock = rule_sock(
            [
                ("/interface/print", ("=name=ether3", "=type=ether")),
                (
                    "/ipv6/firewall/filter/print",
                    ("=chain=forward", "=action=drop", "=in-interface=ether3",
                     "=comment=isp-centric-hotspot-drop-v6", "=.id=*5"),
                ),
            ]
        )
        report = routeros_api.apply_port_uses(
            "10.88.0.5", "secret-password", {"ether3": ["lan"]}, opener=lambda _address, _timeout: sock
        )
        self.assertTrue(report["applied"])
        sent = b"".join(sock.sent)
        self.assertIn(b"/ipv6/firewall/filter/remove", sent)
        self.assertNotIn(b"/ipv6/firewall/filter/add", sent)

    def test_hotspot_off_keeps_ipv6_blocked(self):
        sock = sock_with(("=name=ether3", "=type=ether", "=comment=Hotspot"))
        report = routeros_api.apply_hotspot_access(
            "10.88.0.5", "secret-password", False, opener=lambda _address, _timeout: sock
        )
        self.assertTrue(report["applied"])
        sent = b"".join(sock.sent)
        self.assertIn(b"isp-centric-hotspot-block", sent)
        self.assertIn(b"/ipv6/firewall/filter/add", sent)
        self.assertIn(b"isp-centric-hotspot-drop-v6", sent)

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

    def test_authorize_locks_login_to_paying_device(self):
        done = sentence("!done")
        profile_row = sentence("!re", "=.id=*7", "=name=hs-pkg1", "=shared-users=5") + done
        active = (
            sentence("!re", "=.id=*A", "=user=hs-abc123", "=mac-address=11:22:33:44:55:66")
            + sentence("!re", "=.id=*B", "=user=hs-abc123", "=mac-address=AA:BB:CC:DD:EE:FF")
            + done
        )
        # login, gate sweep (profiles, users, bindings, walled ip, walled),
        # user profiles, profile set, users, user add, active sessions, then the rest.
        sock = ScriptedSocket([done] * 6 + [profile_row, done, done, done, active] + [done] * 20)
        routeros_api.authorize_hotspot_client(
            "10.88.0.5", "secret-password", "10.5.50.10", "aa-bb-cc-dd-ee-ff",
            "hs-abc123", "pw-xyz", "hs-pkg1", "5M/10M", 1, "7200s",
            opener=lambda _address, _timeout: sock,
        )
        sent = b"".join(sock.sent)
        self.assertIn(b"/ip/hotspot/user/profile/set", sent)
        self.assertIn(b"=shared-users=1", sent)
        self.assertIn(b"/ip/hotspot/user/add", sent)
        self.assertEqual(sent.count(b"=mac-address=AA:BB:CC:DD:EE:FF"), 2)
        self.assertIn(b"=.id=*A", sent)
        self.assertNotIn(b"=.id=*B", sent)

    def test_authorize_without_mac_skips_login(self):
        sock = sock_with()
        report = routeros_api.authorize_hotspot_client(
            "10.88.0.5", "secret-password", "10.5.50.10", "", "hs-abc123", "pw-xyz", "hs-pkg1", "", 1, "1h",
            opener=lambda _address, _timeout: sock,
        )
        self.assertFalse(report["online"])
        self.assertNotIn(b"/ip/hotspot/active/login", b"".join(sock.sent))

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

    def test_preview_html_fills_tokens_and_stops_redirects(self):
        import api

        login = api.hotspot_preview_html(portal_server.router_page("login.html"))
        self.assertNotIn("$(", login)
        self.assertNotIn('http-equiv="refresh"', login)
        status = api.hotspot_preview_html(portal_server.router_page("status.html"))
        self.assertNotIn('http-equiv="refresh"', status)
        error = api.hotspot_preview_html(portal_server.router_page("error.html"))
        self.assertNotIn("$(error)", error)
        self.assertIn("session ended", error)

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

    def test_pay_page_redirects_paid_users_to_thank_you(self):
        row = {
            "first_name": "Amina",
            "last_name": "Wanjiku",
            "phone": "0712345678",
            "package_id": "pkg-1",
            "package_name": "Home 10",
            "pppoe_username": "0712345678",
            "price": "500.00",
            "cycle_days": 30,
        }
        offers = [
            {
                "id": "pkg-1",
                "name": "Home 10",
                "price": "500.00",
                "download_mbps": 10,
                "upload_mbps": 5,
                "simultaneous_devices": 1,
                "image_data_url": None,
                "period": "1 month",
            }
        ]
        html = portal_server.pay_page(row, offers, {"account_type": "paybill", "short_code": "123456"}).decode()
        self.assertIn("/thank-you?code=", html)

    def test_thankyou_page_shows_voucher_receipt(self):
        body = portal_server.thankyou_page(
            {
                "code": "4821K",
                "amount": "500.00",
                "status": "issued",
                "package_name": "Home 10",
                "first_name": "Amina",
                "last_name": "Wanjiku",
                "pppoe_username": "0712345678",
            }
        ).decode()
        self.assertIn("4821K", body)
        self.assertIn("Home 10", body)
        self.assertIn("0712345678", body)
        self.assertIn("Thank you, Amina Wanjiku!", body)
        self.assertIn("cannot be used again", body)

    def test_thankyou_page_marks_spent_voucher(self):
        body = portal_server.thankyou_page(
            {
                "code": "4821K",
                "amount": "500.00",
                "status": "used",
                "package_name": "Home 10",
                "first_name": "Amina",
                "last_name": "Wanjiku",
                "pppoe_username": "0712345678",
            }
        ).decode()
        self.assertIn("Voucher used", body)
        self.assertIn("Already used", body)

    def test_thankyou_page_handles_unknown_code(self):
        body = portal_server.thankyou_page(None).decode()
        self.assertIn("Thank you for your payment", body)


class HotspotVoucherTests(unittest.TestCase):
    def test_issue_hotspot_vouchers_one_per_device_slot(self):
        cursor = HsVoucherCursor()
        vouchers = portal_server.issue_hotspot_vouchers(cursor, pending_purchase(devices=3))
        self.assertEqual(len(vouchers), 3)
        self.assertEqual(len({v["code"] for v in vouchers}), 3)
        self.assertEqual(len({v["username"] for v in vouchers}), 3)
        # Idempotent: polling again returns the same vouchers, no extra inserts.
        again = portal_server.issue_hotspot_vouchers(cursor, pending_purchase(devices=3))
        self.assertEqual([v["code"] for v in again], [v["code"] for v in vouchers])
        inserts = [sql for sql in cursor.statements if sql.startswith("INSERT INTO hotspot_vouchers")]
        self.assertEqual(len(inserts), 3)

    def test_normalize_voucher_code(self):
        self.assertEqual(portal_server.normalize_voucher_code("4821k"), "4821K")
        self.assertEqual(portal_server.normalize_voucher_code(" 48-21 k "), "4821K")
        # Older XXXX-XXXX-XXXX codes are still recognised.
        self.assertEqual(portal_server.normalize_voucher_code("abcd-2345-wxyz"), "ABCD-2345-WXYZ")
        self.assertEqual(portal_server.normalize_voucher_code("abcd2345wxyz"), "ABCD-2345-WXYZ")
        self.assertEqual(portal_server.normalize_voucher_code(" ab-cd 2345 wx-yz "), "ABCD-2345-WXYZ")

    def test_hotspot_voucher_is_spent_once_online(self):
        cursor = HsVoucherCursor()
        vouchers = portal_server.issue_hotspot_vouchers(cursor, pending_purchase())
        self.assertEqual(pppoe_store.mark_hotspot_vouchers_used(cursor, ["someone-else"]), 0)
        self.assertEqual(pppoe_store.mark_hotspot_vouchers_used(cursor, [vouchers[0]["username"]]), 1)
        # A spent voucher can never be consumed again.
        self.assertEqual(pppoe_store.mark_hotspot_vouchers_used(cursor, [vouchers[0]["username"]]), 0)

    def test_paid_result_lists_vouchers_and_thank_you_target(self):
        cursor = HsVoucherCursor()
        vouchers = portal_server.issue_hotspot_vouchers(cursor, pending_purchase())
        row = {
            "purchase_id": "pu-1",
            "username": vouchers[0]["username"],
            "password": vouchers[0]["password"],
            "login_url": "http://10.5.50.1/login",
            "orig_url": "http://example.com/",
            "paid_at": None,
        }
        body = portal_server.hotspot_paid_result(cursor, row)
        self.assertEqual(body["purchase"], "pu-1")
        self.assertEqual([v["code"] for v in body["vouchers"]], [v["code"] for v in vouchers])
        # The router login hands off to the thank-you page once connected.
        self.assertIn("username=", body["loginUrl"])
        self.assertIn("dst=", body["loginUrl"])
        self.assertIn("thank-you", body["loginUrl"])

    def test_hotspot_page_offers_voucher_redemption(self):
        device = {"id": "router-1", "name": "Shop", "site": "CBD"}
        html = portal_server.hotspot_page(
            device, [], {"ip": "10.5.50.2", "mac": "AA:BB:CC:DD:EE:FF"}, None
        ).decode()
        self.assertIn("/hotspot/redeem", html)
        self.assertIn("Have a voucher?", html)
        self.assertIn("id=vcode", html)

    def test_thankyou_hotspot_page_lists_every_voucher(self):
        receipt = {
            "id": "pu-1",
            "amount": "1500.00",
            "devices": 2,
            "package_name": "Weekend bundle",
            "vouchers": [
                {"code": "4821K", "status": "used"},
                {"code": "7359M", "status": "issued"},
            ],
        }
        body = portal_server.thankyou_hotspot_page(receipt).decode()
        self.assertIn("4821K", body)
        self.assertIn("7359M", body)
        self.assertIn("Used", body)
        self.assertIn("Ready", body)
        self.assertIn("Weekend bundle", body)
        self.assertIn("cannot be used again", body)

    def test_thankyou_hotspot_page_handles_unknown_purchase(self):
        body = portal_server.thankyou_hotspot_page(None).decode()
        self.assertIn("Thank you for your payment", body)


class IdentifyCursor:
    """Serves the radacct session + subscriber lookups portal_server.identify runs."""

    def __init__(self, sessions, subscribers):
        self.sessions = sessions
        self.subscribers = subscribers
        self.asked = []
        self.queries = []
        self._all = []
        self._one = None

    def execute(self, sql, args=None):
        flat = " ".join(sql.split())
        self.queries.append(flat)
        self._all = []
        self._one = None
        if flat.startswith("SELECT r.username FROM radacct"):
            self._all = list(self.sessions)
        elif "FROM pppoe_subscribers s" in flat:
            self.asked.append(args[0])
            row = self.subscribers.get(args[0])
            self._one = dict(row) if row else None

    def fetchall(self):
        return list(self._all)

    def fetchone(self):
        return self._one


def captive_row(**extra):
    row = {
        "subscriber_id": "sub-1",
        "client_id": "client-1",
        "first_name": "Amina",
        "last_name": "Wanjiku",
        "phone": "0712345678",
        "pppoe_username": "amina-home",
        "status": "active",
        "router_id": "router-1",
        "package_id": "pkg-1",
        "package_name": "Home 10",
        "download_mbps": 10,
        "upload_mbps": 5,
        "package_devices": 2,
        "price": "500.00",
        "billing_cycle": "monthly",
        "cycle_days": 30,
        "grace_days": 3,
    }
    row.update(extra)
    return row


class PortalIdentifyTests(unittest.TestCase):
    def test_identify_finds_subscriber_missing_billing_rows(self):
        # A subscriber with no pppoe_subscriptions or isp_packages row still
        # owns the session — the recharge page needs them found, not lost to
        # the INNER JOINs that used to hide them.
        row = captive_row(
            package_name=None,
            download_mbps=None,
            upload_mbps=None,
            package_devices=None,
            price=None,
            billing_cycle=None,
            cycle_days=None,
            grace_days=None,
        )
        cursor = IdentifyCursor([{"username": "amina-home"}], {"amina-home": row})
        found = portal_server.identify(cursor, "10.10.0.9")
        self.assertEqual(found["subscriber_id"], "sub-1")
        self.assertIsNone(found["price"])
        joined = " ".join(cursor.queries)
        self.assertIn("LEFT JOIN pppoe_subscriptions", joined)
        self.assertIn("LEFT JOIN isp_packages", joined)

    def test_identify_resolves_dialed_aliases(self):
        subscribers = {
            "amina-home": captive_row(pppoe_username="amina-home"),
            "0712345678": captive_row(subscriber_id="sub-2", pppoe_username="0712345678"),
        }
        for dialed, wanted in (
            ("amina-home@isp", "amina-home"),
            ("HOME\\amina-home", "amina-home"),
            ("254712345678", "0712345678"),
            ("712345678", "0712345678"),
        ):
            cursor = IdentifyCursor([{"username": dialed}], subscribers)
            found = portal_server.identify(cursor, "10.10.0.9")
            self.assertIsNotNone(found, dialed)
            self.assertEqual(found["pppoe_username"], wanted, dialed)

    def test_identify_returns_none_for_unknown_ip(self):
        cursor = IdentifyCursor([], {})
        self.assertIsNone(portal_server.identify(cursor, "10.10.9.9"))

    def test_identify_tries_recent_sessions_until_a_match(self):
        cursor = IdentifyCursor(
            [{"username": "ghost-user"}, {"username": "amina-home"}],
            {"amina-home": captive_row()},
        )
        found = portal_server.identify(cursor, "10.10.0.9")
        self.assertEqual(found["subscriber_id"], "sub-1")
        self.assertIn("amina-home", cursor.asked)


class PayPageMissingRowsTests(unittest.TestCase):
    def test_pay_page_renders_without_subscription_or_package(self):
        row = captive_row(price=None, cycle_days=None, package_name=None)
        offers = [
            {
                "id": "pkg-2",
                "name": "Home 20",
                "price": "800.00",
                "download_mbps": 20,
                "upload_mbps": 10,
                "simultaneous_devices": 3,
                "image_data_url": None,
                "period": "1 month",
            }
        ]
        html = portal_server.pay_page(row, offers, {"account_type": "paybill", "short_code": "123456"}).decode()
        self.assertIn("Pay with M-Pesa", html)
        self.assertIn("Home 20", html)
        self.assertIn("800", html)

    def test_pppoe_offers_keeps_own_package_when_row_is_gone(self):
        # The subscriber's stored package no longer resolves (deleted or never
        # existed) — it is still offered so the page has something to bill.
        row = captive_row(package_id="pkg-gone", package_name=None, price=None, cycle_days=None)
        offers = portal_server.pppoe_offers(FakeCursor([]), row)
        self.assertEqual(len(offers), 1)
        self.assertEqual(offers[0]["id"], "pkg-gone")
        self.assertEqual(offers[0]["name"], "Current package")
        self.assertEqual(offers[0]["period"], "30 days")


if __name__ == "__main__":
    unittest.main()


class BlockSharingApiTests(unittest.TestCase):
    def device(self, **extra):
        row = {
            "id": "router-1",
            "client_id": "client-1",
            "name": "Shop",
            "tunnel_ip": "10.88.0.5",
            "api_secret": "sealed",
            "pppoe_enforced": 0,
            "hotspot_enabled": 1,
            "hotspot_block_sharing": 1,
        }
        row.update(extra)
        return row

    def reconcile(self, device, state):
        with mock.patch.object(routeros_api, "open_password", return_value="pw"), mock.patch.object(
            routeros_api, "inspect_access", return_value=state
        ), mock.patch.object(api, "_mark_tunnel"), mock.patch.object(
            routeros_api, "apply_hotspot_sharing"
        ) as sharing, mock.patch.object(routeros_api, "apply_hotspot_access") as access:
            api.reconcile_device(None, device)
        return sharing, access

    def test_reconcile_restores_missing_sharing_block(self):
        sharing, access = self.reconcile(
            self.device(), {"pppoe": False, "hotspot": True, "sharing_blocked": False, "read_failed": False}
        )
        sharing.assert_called_once_with("10.88.0.5", "pw", True)
        access.assert_not_called()

    def test_reconcile_leaves_matching_sharing_alone(self):
        sharing, access = self.reconcile(
            self.device(), {"pppoe": False, "hotspot": True, "sharing_blocked": True, "read_failed": False}
        )
        sharing.assert_not_called()
        access.assert_not_called()

    def test_reconcile_unknown_sharing_is_not_touched(self):
        sharing, _access = self.reconcile(
            self.device(), {"pppoe": False, "hotspot": True, "sharing_blocked": None, "read_failed": False}
        )
        sharing.assert_not_called()

    def test_reconcile_rebuilds_hotspot_with_sharing_choice(self):
        _sharing, access = self.reconcile(
            self.device(), {"pppoe": False, "hotspot": False, "sharing_blocked": False, "read_failed": False}
        )
        access.assert_called_once_with("10.88.0.5", "pw", True, block_sharing=True)

    def test_save_switches_only_sharing_on_live_hotspot(self):
        handler = api.Handler.__new__(api.Handler)
        rows = iter([{"hotspotEnabled": True, "hotspotBlockSharing": False}, {"hotspotEnabled": True, "hotspotBlockSharing": True}])
        cursor = FakeCursor([])
        with mock.patch.object(handler, "require_client", return_value="client-1", create=True), mock.patch.object(
            handler, "mikrotik_row", side_effect=lambda *_args: next(rows), create=True
        ), mock.patch.object(handler, "push_hotspot_access", return_value={"message": "Updated on the router."}, create=True) as push:
            body = handler.save_hotspot_access(cursor, "router-1", "token", {"enabled": True, "blockSharing": True, "push": True})
        self.assertTrue(body["applied"])
        push.assert_called_once_with(cursor, "router-1", "client-1", True, True, True)
        self.assertEqual(cursor.queries[0][1], (1, 1, "router-1", "client-1"))

    def test_save_rejects_non_boolean_sharing(self):
        handler = api.Handler.__new__(api.Handler)
        with mock.patch.object(handler, "require_client", return_value="client-1", create=True), mock.patch.object(
            handler, "mikrotik_row", return_value={"hotspotEnabled": True}, create=True
        ):
            with self.assertRaises(api.ApiError):
                handler.save_hotspot_access(FakeCursor([]), "router-1", "token", {"enabled": True, "blockSharing": "yes"})
