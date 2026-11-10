import base64
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import remote_access
import routeros_api


def sentence(*words):
    return routeros_api.encode_sentence(words)


class ScriptedSocket:
    def __init__(self, replies):
        self.replies = list(replies)
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


class RemoteAccessTests(unittest.TestCase):
    def setUp(self):
        with remote_access._LOCK:
            remote_access._SESSIONS.clear()
            remote_access._BY_SUBSCRIBER.clear()

    def test_comment_is_namespaced(self):
        comment = routeros_api.remote_access_comment("ab12cd")
        self.assertTrue(comment.startswith("isp-centric-remote-access:"))
        self.assertNotIn("pppoe", comment)
        self.assertNotIn("portal", comment)

    def test_install_only_adds_comment_scoped_rules(self):
        done = sentence("!done")
        replies = [
            done,  # login
            sentence("!re", "=.id=*9", "=comment=isp-centric-remote-access:old") + done,  # nat print (other session)
            done,  # filter print during clear (none for this comment)
            sentence("!re", "=.id=*1", "=chain=forward", "=action=drop") + done,  # forward drop anchor
            done,  # dstnat add
            done,  # srcnat add
            done,  # forward accept out
            done,  # forward accept back
        ]
        sock = ScriptedSocket(replies)
        result = routeros_api.install_remote_access(
            "10.88.0.5",
            "secret-password",
            "10.10.0.247",
            41234,
            "isp-centric-remote-access:ab12cd",
            server_ip="10.88.0.1",
            opener=lambda _address, _timeout: sock,
        )
        self.assertTrue(result["installed"])
        sent = b"".join(sock.sent)
        self.assertIn(b"/ip/firewall/nat/add", sent)
        self.assertIn(b"=action=dst-nat", sent)
        self.assertIn(b"=to-addresses=10.10.0.247", sent)
        self.assertIn(b"=dst-port=41234", sent)
        self.assertIn(b"=in-interface=isp-centric", sent)
        self.assertIn(b"=action=masquerade", sent)
        self.assertIn(b"=src-address=10.88.0.1", sent)
        self.assertIn(b"isp-centric-remote-access:ab12cd", sent)
        # Must not touch live PPPoE / portal / WireGuard surfaces.
        self.assertNotIn(b"/ppp/", sent)
        self.assertNotIn(b"/interface/wireguard", sent)
        self.assertNotIn(b"pppoe-subscribed", sent)
        self.assertNotIn(b"pppoe-suspended", sent)
        self.assertNotIn(b"isp-centric-portal", sent)
        self.assertNotIn(b"AllowedIPs", sent)
        self.assertNotIn(b"10.10.0.0/24", sent)

    def test_install_rejects_public_cpe_and_wrong_comment(self):
        with self.assertRaises(routeros_api.RouterError):
            routeros_api.install_remote_access(
                "10.88.0.5",
                "secret",
                "8.8.8.8",
                41234,
                "isp-centric-remote-access:x",
                opener=lambda *_: ScriptedSocket([]),
            )
        with self.assertRaises(routeros_api.RouterError):
            routeros_api.install_remote_access(
                "10.88.0.5",
                "secret",
                "10.10.0.2",
                41234,
                "something-else",
                opener=lambda *_: ScriptedSocket([]),
            )

    def test_clear_all_prefix_rules(self):
        done = sentence("!done")
        replies = [
            done,
            sentence("!re", "=.id=*1", "=comment=isp-centric-remote-access:one")
            + sentence("!re", "=.id=*2", "=comment=isp-centric-portal-nat")
            + done,
            done,  # remove *1
            sentence("!re", "=.id=*3", "=comment=isp-centric-remote-access:one")
            + sentence("!re", "=.id=*4", "=comment=isp-centric-pppoe-allow")
            + done,
            done,  # remove *3
        ]
        sock = ScriptedSocket(replies)
        routeros_api.clear_remote_access("10.88.0.5", "secret", opener=lambda *_: sock)
        sent = b"".join(sock.sent)
        self.assertIn(b"=.id=*1", sent)
        self.assertIn(b"=.id=*3", sent)
        self.assertNotIn(b"=.id=*2", sent)
        self.assertNotIn(b"=.id=*4", sent)

    def test_open_session_uses_tunnel_proxy_url(self):
        with mock.patch("remote_access.routeros_api.install_remote_access") as install, mock.patch(
            "remote_access._probe_forward", return_value=True
        ):
            install.return_value = {"installed": True}
            session = remote_access.open_session(
                client_id="client-1",
                subscriber_id="sub-1",
                tunnel_ip="10.88.0.5",
                api_password="api-secret",
                cpe_ip="10.10.0.247",
                cpe_password="router-pass",
            )
        self.assertTrue(session["url"].startswith("/api/pppoe/remote/"))
        self.assertEqual(session["target"], "http://10.10.0.247:80")
        install.assert_called_once()
        kwargs = install.call_args
        self.assertEqual(kwargs.args[0], "10.88.0.5")
        self.assertEqual(kwargs.args[2], "10.10.0.247")

    def test_rewrite_helpers_keep_proxy_prefix(self):
        prefix = "/api/pppoe/remote/tok/"
        self.assertEqual(remote_access._rewrite_location("http://10.10.0.247/login", prefix), "/api/pppoe/remote/tok/login")
        self.assertEqual(remote_access._rewrite_location("/status", prefix), "/api/pppoe/remote/tok/status")
        cookie = remote_access._rewrite_cookie("a=1; Path=/; Domain=10.10.0.247; Secure", prefix)
        self.assertIn("Path=/api/pppoe/remote/tok/", cookie)
        self.assertNotIn("Domain=", cookie)
        html = remote_access._inject_base(b"<html><head></head><body>x</body></html>", "text/html", prefix)
        self.assertIn(b'<base href="/api/pppoe/remote/tok/">', html)

    def test_basic_auth_header_encoding(self):
        expected = base64.b64encode(b"admin:secret").decode()
        self.assertEqual(expected, "YWRtaW46c2VjcmV0")


if __name__ == "__main__":
    unittest.main()
