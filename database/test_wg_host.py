"""WireGuard host safety: never silently mint a new server identity."""

import base64
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

import wg_host


def _pair():
    private = X25519PrivateKey.generate()
    private_raw = private.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    public_raw = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(private_raw).decode(), base64.b64encode(public_raw).decode()


class WireGuardKeySafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.patches = [
            mock.patch.object(wg_host, "ROOT", root),
            mock.patch.object(wg_host, "KEY_FILE", root / "server.key"),
            mock.patch.object(wg_host, "CONFIG_FILE", root / "isp-centric.conf"),
            mock.patch.object(wg_host, "SYNC_FILE", root / "isp-centric.sync.conf"),
            mock.patch.object(
                wg_host,
                "_config_candidates",
                side_effect=lambda: [root / "isp-centric.conf", root / "isp-centric.sync.conf"],
            ),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        os.environ.pop("ISP_WG_ALLOW_NEW_KEY", None)

    def test_first_install_mints_key(self):
        private_key, public_key = wg_host.load_or_create_keypair()
        self.assertTrue(private_key.endswith("="))
        self.assertEqual(public_key, wg_host._public_from_private(private_key))
        self.assertTrue(wg_host.KEY_FILE.exists())

    def test_recovers_private_key_from_config(self):
        private_key, public_key = _pair()
        wg_host.CONFIG_FILE.write_text(
            f"[Interface]\nPrivateKey = {private_key}\nListenPort = 51820\n",
            encoding="utf-8",
        )
        got_private, got_public = wg_host.load_or_create_keypair()
        self.assertEqual(got_private, private_key)
        self.assertEqual(got_public, public_key)
        self.assertEqual(wg_host.KEY_FILE.read_text(encoding="utf-8").splitlines()[0], private_key)

    def test_refuses_new_key_when_config_exists(self):
        wg_host.CONFIG_FILE.write_text("[Interface]\nListenPort = 51820\n", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            wg_host.load_or_create_keypair()

    def test_allow_new_key_override(self):
        wg_host.CONFIG_FILE.write_text("[Interface]\nListenPort = 51820\n", encoding="utf-8")
        os.environ["ISP_WG_ALLOW_NEW_KEY"] = "1"
        try:
            private_key, _public_key = wg_host.load_or_create_keypair()
        finally:
            os.environ.pop("ISP_WG_ALLOW_NEW_KEY", None)
        self.assertTrue(private_key.endswith("="))


class WireGuardRestartSafetyTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("ISP_WG_ALLOW_RESTART", None)

    def _run_posix(self, fake_run):
        conf = mock.Mock()
        conf.read_text.return_value = "updated"
        sync = mock.Mock()
        current = mock.Mock()
        current.exists.return_value = True
        current.read_text.return_value = "previous"
        etc = mock.Mock()
        etc.__truediv__ = mock.Mock(return_value=current)

        with mock.patch("shutil.which", side_effect=lambda name: f"/bin/{name}"), mock.patch(
            "subprocess.run", side_effect=fake_run
        ), mock.patch.object(wg_host, "tunnel_running", return_value=True), mock.patch.object(
            wg_host, "runtime_config", return_value=(conf, sync)
        ), mock.patch.object(wg_host, "_ensure_posix_routes"), mock.patch.object(
            wg_host, "_allow_posix_port"
        ), mock.patch.object(wg_host, "Path", side_effect=lambda *_args, **_kwargs: etc), mock.patch(
            "wg_host.os.geteuid", create=True, return_value=0
        ):
            wg_host._apply_posix([("pub", "10.88.0.2")])

    def test_posix_refuses_down_up_when_syncconf_fails(self):
        commands = []

        def fake_run(command, **_kwargs):
            commands.append(list(command))
            return mock.Mock(returncode=1, stderr="boom", stdout="")

        self._run_posix(fake_run)
        self.assertEqual(commands, [["/bin/wg", "syncconf", wg_host.TUNNEL_NAME, mock.ANY]])
        self.assertTrue(all("wg-quick" not in str(cmd[0]) for cmd in commands))

    def test_posix_restarts_when_allowed(self):
        os.environ["ISP_WG_ALLOW_RESTART"] = "1"
        commands = []

        def fake_run(command, **_kwargs):
            commands.append(list(command))
            code = 0 if command and str(command[0]).endswith("wg-quick") else 1
            return mock.Mock(returncode=code, stderr="boom", stdout="")

        try:
            self._run_posix(fake_run)
        finally:
            os.environ.pop("ISP_WG_ALLOW_RESTART", None)

        self.assertEqual(commands[0][:2], ["/bin/wg", "syncconf"])
        self.assertEqual(commands[1][:2], ["/bin/wg-quick", "down"])
        self.assertEqual(commands[2][:2], ["/bin/wg-quick", "up"])


if __name__ == "__main__":
    unittest.main()
