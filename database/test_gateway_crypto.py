"""Offline tests for the gateway AES-GCM envelope — no database needed."""

import base64
import contextlib
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import gateway_crypto

ENV_KEYS = (
    "ISP_GATEWAY_SECRET",
    "ISP_GATEWAY_KEY_ID",
    "ISP_GATEWAY_SECRETS_OLD",
    "ISP_ENV",
    "ISP_ROUTER_SECRET",
    "ISP_ACCOUNT_CODE_SECRET",
)


@contextlib.contextmanager
def env(**updates):
    saved = {key: os.environ.get(key) for key in ENV_KEYS}
    for key in ENV_KEYS:
        os.environ.pop(key, None)
    os.environ.update({key: value for key, value in updates.items() if value is not None})
    try:
        yield
    finally:
        for key in ENV_KEYS:
            os.environ.pop(key, None)
        os.environ.update({key: value for key, value in saved.items() if value is not None})


class SealOpenTests(unittest.TestCase):
    def test_roundtrip(self):
        with env(ISP_GATEWAY_SECRET="top-secret", ISP_GATEWAY_KEY_ID="g7"):
            sealed = gateway_crypto.seal("consumer-secret-value")
            self.assertTrue(sealed.startswith("gcm1.g7."))
            self.assertNotIn("consumer-secret-value", sealed)
            self.assertEqual(gateway_crypto.open_secret(sealed), "consumer-secret-value")

    def test_empty_and_plaintext_pass_through(self):
        self.assertEqual(gateway_crypto.open_secret(""), "")
        self.assertIsNone(gateway_crypto.open_secret(None))
        self.assertEqual(gateway_crypto.open_secret("legacy-plaintext"), "legacy-plaintext")

    def test_double_seal_is_a_noop(self):
        with env(ISP_GATEWAY_SECRET="k"):
            sealed = gateway_crypto.seal("value")
            self.assertEqual(gateway_crypto.seal(sealed), sealed)

    def test_tamper_is_detected(self):
        with env(ISP_GATEWAY_SECRET="k"):
            sealed = gateway_crypto.seal("value")
            version, key_id, packed = sealed.split(".", 2)
            raw = bytearray(base64.b64decode(packed))
            raw[-1] ^= 0x01
            forged = f"{version}.{key_id}.{base64.b64encode(bytes(raw)).decode()}"
            with self.assertRaises(gateway_crypto.GatewayCryptoError):
                gateway_crypto.open_secret(forged)

    def test_malformed_envelope(self):
        with env(ISP_GATEWAY_SECRET="k"):
            with self.assertRaises(gateway_crypto.GatewayCryptoError):
                gateway_crypto.open_secret("gcm1.g1.not-base64!!!")

    def test_unknown_key_id_rejected(self):
        with env(ISP_GATEWAY_SECRET="k", ISP_GATEWAY_KEY_ID="g2"):
            with self.assertRaises(gateway_crypto.GatewayCryptoError):
                gateway_crypto.open_secret(
                    "gcm1.g9." + base64.b64encode(b"x" * 40).decode()
                )

    def test_rotation_old_key_still_opens(self):
        with env(ISP_GATEWAY_SECRET="old-secret", ISP_GATEWAY_KEY_ID="g1"):
            sealed = gateway_crypto.seal("initiator-password")
        with env(
            ISP_GATEWAY_SECRET="new-secret",
            ISP_GATEWAY_KEY_ID="g2",
            ISP_GATEWAY_SECRETS_OLD="g1=old-secret",
        ):
            self.assertEqual(gateway_crypto.open_secret(sealed), "initiator-password")
            fresh = gateway_crypto.seal("another")
            self.assertTrue(fresh.startswith("gcm1.g2."))

    def test_dev_fallback_key(self):
        with env():
            sealed = gateway_crypto.seal("value")
            self.assertTrue(gateway_crypto.is_sealed(sealed))
            self.assertEqual(gateway_crypto.open_secret(sealed), "value")

    def test_production_requires_the_env_key(self):
        with env(ISP_ENV="production"):
            with self.assertRaises(gateway_crypto.GatewayCryptoError):
                gateway_crypto.seal("value")

    def test_production_falls_back_to_the_router_secret(self):
        with env(ISP_ENV="production", ISP_ROUTER_SECRET="router-secret"):
            sealed = gateway_crypto.seal("value")
            self.assertTrue(sealed.startswith("gcm1.s1."))
            self.assertEqual(gateway_crypto.open_secret(sealed), "value")
        with env(ISP_ENV="production", ISP_ACCOUNT_CODE_SECRET="code-secret"):
            self.assertTrue(gateway_crypto.seal("value").startswith("gcm1.s1."))

    def test_router_secret_rows_still_open_after_a_gateway_key_is_set(self):
        with env(ISP_ENV="production", ISP_ROUTER_SECRET="router-secret"):
            sealed = gateway_crypto.seal("value")
        with env(ISP_ENV="production", ISP_ROUTER_SECRET="router-secret", ISP_GATEWAY_SECRET="gw"):
            self.assertTrue(gateway_crypto.seal("other").startswith("gcm1.g1."))
            self.assertEqual(gateway_crypto.open_secret(sealed), "value")
        with env(ISP_ENV="production", ISP_ROUTER_SECRET="changed"):
            with self.assertRaises(gateway_crypto.GatewayCryptoError):
                gateway_crypto.open_secret(sealed)

    def test_development_keeps_the_built_in_key(self):
        with env(ISP_ROUTER_SECRET="router-secret"):
            self.assertTrue(gateway_crypto.seal("value").startswith("gcm1.g1."))


if __name__ == "__main__":
    unittest.main()
