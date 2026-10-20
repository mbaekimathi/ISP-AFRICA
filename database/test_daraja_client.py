"""Offline tests for daraja_client — every call and error path through a
fake transport, no network. The Safaricom cert is generated in-memory."""

import base64
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import daraja_client
from daraja_client import DarajaClient, DarajaConfig, DarajaError, DarajaTimeout


def make_config(**overrides):
    values = {
        "environment": "sandbox",
        "consumer_key": "key-1",
        "consumer_secret": "secret-1",
        "short_code": "600000",
        "passkey": "pass",
        "account_type": "paybill",
        "initiator_name": "initiator1",
        "initiator_password": "init-pass",
        "payout_shortcode": "600099",
    }
    values.update(overrides)
    return DarajaConfig(**values)


class FakeTransport:
    """Records requests and replays canned (status, body) responses."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []
        self.fail_with = None

    def __call__(self, url, headers, body, timeout):
        self.calls.append({"url": url, "headers": dict(headers), "body": body})
        if self.fail_with is not None:
            error, self.fail_with = self.fail_with, None
            raise error
        item = self.responses.pop(0)
        if isinstance(item, tuple):
            status, payload = item
        else:
            status, payload = 200, item
        return status, payload if isinstance(payload, bytes) else json.dumps(payload).encode()

    @property
    def last(self):
        return self.calls[-1]

    def last_json(self):
        return json.loads(self.last["body"].decode())

    def urls(self):
        return [call["url"] for call in self.calls]


TOKEN_OK = {"access_token": "tok-abc", "expires_in": "3600"}
ACK = {"ResponseCode": "0", "ResponseDescription": "Accepted"}


def fresh_client(transport, **config):
    """A client with no cached token and a never-sleeping backoff."""
    with daraja_client._TOKEN_LOCK:
        daraja_client._TOKEN_CACHE.clear()
    return DarajaClient(make_config(**config), transport=transport, sleep=lambda s: None)


class MsisdnTests(unittest.TestCase):
    def test_normalise_all_kenyan_formats(self):
        for raw in ("0700123456", "+254700123456", "254700123456", "700123456",
                    " 0700 123 456 ", "00254700123456"):
            self.assertEqual(daraja_client.normalize_msisdn(raw), "254700123456")
        self.assertEqual(daraja_client.normalize_msisdn("0110123456"), "254110123456")
        self.assertEqual(daraja_client.normalize_msisdn("254110123456"), "254110123456")

    def test_rejects_foreign_and_short_numbers(self):
        for bad in ("", "0712", "+15551234567", "254800123456", "abc", "2547001234567"):
            with self.assertRaises(DarajaError):
                daraja_client.normalize_msisdn(bad)

    def test_shortcode_validation(self):
        self.assertEqual(daraja_client.validate_shortcode("600000"), "600000")
        self.assertEqual(daraja_client.validate_shortcode("1234"), "1234")
        for bad in ("", "abc", "123", "12345678901"):
            with self.assertRaises(DarajaError):
                daraja_client.validate_shortcode(bad)


class TokenTests(unittest.TestCase):
    def test_token_fetched_once_and_cached(self):
        transport = FakeTransport(TOKEN_OK, ACK, ACK)
        client = fresh_client(transport)
        client.stk_query("ws_CO_1")
        client.stk_query("ws_CO_2")
        self.assertEqual(transport.urls().count(
            "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials"), 1)
        for call in transport.calls[1:]:
            self.assertEqual(call["headers"]["Authorization"], "Bearer tok-abc")

    def test_expired_token_refetches(self):
        transport = FakeTransport({"access_token": "t1", "expires_in": "30"}, TOKEN_OK, ACK)
        client = fresh_client(transport)
        client.token()
        client.stk_query("ws_CO_9")
        self.assertEqual(sum("oauth" in url for url in transport.urls()), 2)

    def test_token_cache_scoped_per_environment_and_key(self):
        transport = FakeTransport(TOKEN_OK, TOKEN_OK)
        client = fresh_client(transport)
        other = DarajaClient(
            make_config(consumer_key="key-2"), transport=transport, sleep=lambda s: None
        )
        client.token()
        other.token()
        self.assertEqual(sum("oauth" in url for url in transport.urls()), 2)

    def test_401_drops_the_cached_token(self):
        transport = FakeTransport(TOKEN_OK, (401, {"errorMessage": "bad token"}))
        client = fresh_client(transport)
        client.token()
        with self.assertRaises(DarajaError):
            client.stk_query("ws_CO_x")
        self.assertEqual(daraja_client._TOKEN_CACHE, {})


class StkTests(unittest.TestCase):
    def test_stk_push_payload(self):
        transport = FakeTransport(TOKEN_OK, ACK)
        client = fresh_client(transport)
        client.stk_push("0700123456", "99.50", "user1", "https://cb.example/x")
        body = transport.last_json()
        self.assertTrue(transport.last["url"].endswith("/mpesa/stkpush/v1/processrequest"))
        self.assertEqual(body["BusinessShortCode"], "600000")
        self.assertEqual(body["TransactionType"], "CustomerPayBillOnline")
        self.assertEqual(body["Amount"], 100)  # rounded up, whole shillings
        self.assertEqual(body["PartyA"], "254700123456")
        self.assertEqual(body["PhoneNumber"], "254700123456")
        self.assertEqual(body["CallBackURL"], "https://cb.example/x")
        self.assertEqual(body["AccountReference"], "user1")
        decoded = base64.b64decode(body["Password"]).decode()
        self.assertTrue(decoded.startswith("600000pass"))
        self.assertEqual(decoded[-14:], body["Timestamp"])

    def test_stk_push_till_type(self):
        transport = FakeTransport(TOKEN_OK, ACK)
        client = fresh_client(transport, account_type="till")
        client.stk_push("0700123456", 10, "ref", "https://cb.example/x")
        self.assertEqual(transport.last_json()["TransactionType"], "CustomerBuyGoodsOnline")

    def test_stk_push_never_retries(self):
        transport = FakeTransport(TOKEN_OK)
        client = fresh_client(transport)
        client.token()  # authenticate first so only the push is counted
        transport.calls.clear()
        transport.fail_with = TimeoutError("read timed out")
        with self.assertRaises(DarajaTimeout):
            client.stk_push("0700123456", 10, "ref", "https://cb.example/x")
        self.assertEqual(sum("stkpush/v1" in u for u in transport.urls()), 1)

    def test_stk_query_payload(self):
        transport = FakeTransport(TOKEN_OK, {"ResultCode": "0", "ResultDesc": "success"})
        client = fresh_client(transport)
        out = client.stk_query("ws_CO_DMZ_123")
        body = transport.last_json()
        self.assertTrue(transport.last["url"].endswith("/mpesa/stkpushquery/v1/query"))
        self.assertEqual(body["CheckoutRequestID"], "ws_CO_DMZ_123")
        self.assertEqual(out["ResultCode"], "0")


class PayoutTests(unittest.TestCase):
    def setUp(self):
        # Every secured call needs a cert — patch it in for the module.
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        import datetime as dt

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test-cert")])
        cert = (
            x509.CertificateBuilder()
            .subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(1).not_valid_before(dt.datetime(2020, 1, 1))
            .not_valid_after(dt.datetime(2040, 1, 1))
            .sign(key, hashes.SHA256())
        )
        self.cert_pem = cert.public_bytes(serialization.Encoding.PEM)
        self._patcher = patch.dict(
            __import__("os").environ, {"ISP_DARAJA_CERT_SANDBOX": self.cert_pem.decode()}
        )
        self._patcher.start()
        self.addCleanup(self._patcher.stop)

    def client(self, transport, **config):
        return fresh_client(transport, **config)

    def test_b2c_payload(self):
        transport = FakeTransport(TOKEN_OK, ACK)
        self.client(transport).b2c(
            "0700123456", "250.60", "https://r.example/ok", "https://r.example/tmo",
            remarks="June settlement", occasion="June")
        body = transport.last_json()
        self.assertTrue(transport.last["url"].endswith("/mpesa/b2c/v1/paymentrequest"))
        self.assertEqual(body["InitiatorName"], "initiator1")
        self.assertEqual(body["CommandID"], "BusinessPayment")
        self.assertEqual(body["Amount"], 251)
        self.assertEqual(body["PartyA"], "600099")  # payout shortcode wins
        self.assertEqual(body["PartyB"], "254700123456")
        self.assertEqual(body["ResultURL"], "https://r.example/ok")
        self.assertEqual(body["QueueTimeOutURL"], "https://r.example/tmo")
        self.assertEqual(body["Remarks"], "June settlement")
        self.assertTrue(body["SecurityCredential"])  # RSA blob, base64

    def test_b2c_rejects_http_callback(self):
        transport = FakeTransport(TOKEN_OK)
        with self.assertRaises(DarajaError):
            self.client(transport).b2c(
                "0700123456", 10, "http://r.example/ok", "https://r.example/tmo")
        self.assertEqual(len(transport.calls), 0)  # failed before any request

    def test_b2c_never_retries_on_timeout(self):
        transport = FakeTransport(TOKEN_OK)
        client = self.client(transport)
        client.token()  # consume auth so only the payout call is counted
        transport.calls.clear()
        transport.fail_with = TimeoutError("boom")
        with self.assertRaises(DarajaTimeout):
            client.b2c("0700123456", 10, "https://r/ok", "https://r/tmo")
        self.assertEqual(len(transport.calls), 1)

    def test_b2b_paybill_payload(self):
        transport = FakeTransport(TOKEN_OK, ACK)
        self.client(transport).b2b_paybill(
            "888880", 500, "ACCT-42", "https://r/ok", "https://r/tmo", remarks="Settle")
        body = transport.last_json()
        self.assertTrue(transport.last["url"].endswith("/mpesa/b2b/v1/paymentrequest"))
        self.assertEqual(body["Initiator"], "initiator1")
        self.assertEqual(body["CommandID"], "BusinessPayBill")
        self.assertEqual(body["SenderIdentifierType"], "4")
        self.assertEqual(body["RecieverIdentifierType"], "4")  # API's spelling
        self.assertEqual(body["PartyA"], "600099")
        self.assertEqual(body["PartyB"], "888880")
        self.assertEqual(body["AccountReference"], "ACCT-42")

    def test_b2b_buygoods_payload(self):
        transport = FakeTransport(TOKEN_OK, ACK)
        self.client(transport).b2b_buygoods(
            "555555", 320, "https://r/ok", "https://r/tmo")
        body = transport.last_json()
        self.assertEqual(body["CommandID"], "BusinessBuyGoods")
        self.assertEqual(body["PartyB"], "555555")
        self.assertNotIn("AccountReference", body)

    def test_payouts_never_retry_5xx_either(self):
        transport = FakeTransport(TOKEN_OK, (500, {"errorMessage": "down"}))
        client = self.client(transport)
        client.token()
        transport.calls.clear()
        with self.assertRaises(DarajaError):
            client.b2b_buygoods("555555", 10, "https://r/ok", "https://r/tmo")
        self.assertEqual(len(transport.calls), 1)


class VerificationTests(unittest.TestCase):
    def setUp(self):
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        import datetime as dt
        import os

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test-cert")])
        cert = (
            x509.CertificateBuilder()
            .subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(1).not_valid_before(dt.datetime(2020, 1, 1))
            .not_valid_after(dt.datetime(2040, 1, 1))
            .sign(key, hashes.SHA256())
        )
        self._patcher = patch.dict(
            os.environ,
            {"ISP_DARAJA_CERT_SANDBOX": cert.public_bytes(serialization.Encoding.PEM).decode()},
        )
        self._patcher.start()
        self.addCleanup(self._patcher.stop)

    def test_transaction_status_payload(self):
        transport = FakeTransport(TOKEN_OK, ACK)
        fresh_client(transport).transaction_status(
            "QBX12345", "https://r/ok", "https://r/tmo")
        body = transport.last_json()
        self.assertTrue(transport.last["url"].endswith("/mpesa/transactionstatus/v1/query"))
        self.assertEqual(body["CommandID"], "TransactionStatusQuery")
        self.assertEqual(body["TransactionID"], "QBX12345")
        self.assertEqual(body["PartyA"], "600099")
        self.assertEqual(body["IdentifierType"], "4")

    def test_account_balance_payload(self):
        transport = FakeTransport(TOKEN_OK, ACK)
        fresh_client(transport).account_balance("https://r/ok", "https://r/tmo")
        body = transport.last_json()
        self.assertTrue(transport.last["url"].endswith("/mpesa/accountbalance/v1/query"))
        self.assertEqual(body["CommandID"], "AccountBalance")
        self.assertEqual(body["IdentifierType"], "4")

    def test_reversal_payload(self):
        transport = FakeTransport(TOKEN_OK, ACK)
        fresh_client(transport).reversal("QBX12345", 100, "https://r/ok", "https://r/tmo")
        body = transport.last_json()
        self.assertTrue(transport.last["url"].endswith("/mpesa/reversal/v1/request"))
        self.assertEqual(body["CommandID"], "TransactionReversal")
        self.assertEqual(body["ReceiverParty"], "600099")
        self.assertEqual(body["RecieverIdentifierType"], "4")

    def test_read_calls_retry_then_succeed(self):
        transport = FakeTransport(
            TOKEN_OK, (500, {"errorMessage": "busy"}), ACK)
        client = fresh_client(transport)
        client.token()
        transport.calls.clear()
        out = client.transaction_status("QBX1", "https://r/ok", "https://r/tmo")
        self.assertEqual(out["ResponseCode"], "0")
        self.assertEqual(len(transport.calls), 2)  # one retry after the 500

    def test_read_calls_give_up_after_max_attempts(self):
        transport = FakeTransport(
            TOKEN_OK, (500, "x"), (502, "x"), (503, {"errorMessage": "still down"}))
        client = fresh_client(transport)
        client.token()
        transport.calls.clear()
        with self.assertRaises(DarajaError):
            client.account_balance("https://r/ok", "https://r/tmo")
        self.assertEqual(len(transport.calls), daraja_client.MAX_ATTEMPTS)


class C2bTests(unittest.TestCase):
    def test_register_payload(self):
        transport = FakeTransport(TOKEN_OK, ACK)
        fresh_client(transport).c2b_register(
            "https://cb.example/confirm", "https://cb.example/validate")
        body = transport.last_json()
        self.assertTrue(transport.last["url"].endswith("/mpesa/c2b/v1/registerurl"))
        self.assertEqual(body["ShortCode"], "600000")
        self.assertEqual(body["ResponseType"], "Completed")
        self.assertEqual(body["ConfirmationURL"], "https://cb.example/confirm")

    def test_simulate_sandbox_only(self):
        transport = FakeTransport(TOKEN_OK, ACK)
        fresh_client(transport).c2b_simulate(100, "0700123456", "REF1")
        body = transport.last_json()
        self.assertEqual(body["CommandID"], "CustomerPayBillOnline")
        self.assertEqual(body["Msisdn"], "254700123456")
        self.assertEqual(body["BillRefNumber"], "REF1")

    def test_simulate_blocked_on_live(self):
        transport = FakeTransport()
        with self.assertRaises(DarajaError):
            fresh_client(transport, environment="live").c2b_simulate(100, "0700123456")
        self.assertEqual(len(transport.calls), 0)


class ErrorPathTests(unittest.TestCase):
    def test_error_body_is_parsed(self):
        transport = FakeTransport(
            TOKEN_OK, (400, {"errorCode": "400.002.02", "errorMessage": "Bad Request - Invalid"}))
        with self.assertRaises(DarajaError) as caught:
            fresh_client(transport).stk_query("ws_x")
        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(caught.exception.code, "400.002.02")
        self.assertIn("Invalid", str(caught.exception))

    def test_transport_failure_on_read_retries_then_times_out(self):
        transport = FakeTransport()
        transport.fail_with = TimeoutError("dead")
        client = fresh_client(transport)
        with self.assertRaises(DarajaTimeout):
            client.token()

    def test_missing_cert_blocks_secured_calls(self):
        import os
        with patch.dict(os.environ, {"ISP_DARAJA_CERT_SANDBOX": ""}):
            transport = FakeTransport(TOKEN_OK)
            with self.assertRaises(DarajaError):
                fresh_client(transport).account_balance("https://r/ok", "https://r/tmo")

    def test_mask_msisdn(self):
        self.assertEqual(daraja_client.mask_msisdn("254700123456"), "2547•••••456")
        self.assertEqual(daraja_client.mask_msisdn(""), "")
        self.assertEqual(daraja_client.mask_msisdn("123"), "••••")

    def test_accepted_helper(self):
        self.assertTrue(daraja_client.accepted({"ResponseCode": "0"}))
        self.assertFalse(daraja_client.accepted({"ResponseCode": "1"}))
        self.assertFalse(daraja_client.accepted({}))


if __name__ == "__main__":
    unittest.main()
