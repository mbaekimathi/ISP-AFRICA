"""Server-side Daraja client for the company payment gateway.

One client covers every call the pooled-collection flow needs: OAuth tokens,
STK push/query, C2B URL registration, B2C (phone payouts), B2B BusinessPayBill
and BusinessBuyGoods (paybill/till payouts), Transaction Status, Account
Balance, and Reversal. The HTTP layer is a small injectable transport so tests
run the full request/response matrix with no network.

Money-safety rules baked in:
- OAuth tokens are cached per (environment, consumer key) and refreshed
  before expiry — one auth round-trip, not one per call.
- READ-style calls (token, STK query, transaction status, account balance,
  C2B register) retry on transport failure with backoff. Calls that move
  money (STK push, B2C, B2B, reversal, C2B simulate) NEVER auto-retry — a
  timeout means "unknown", resolved later via Transaction Status.
- Secrets and full phone numbers never appear in logs or exception text.
- Field names follow the current Daraja docs, including the API's own
  spellings (RecieverIdentifierType, Occassion).

The Safaricom security credential is the initiator password RSA-encrypted
with Safaricom's public X.509 certificate (PKCS1v15) and base64'd. Cert paths
come from ISP_DARAJA_CERT_SANDBOX / ISP_DARAJA_CERT_LIVE (a PEM file path or
inline PEM), never the database.
"""

import base64
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

HOSTS = {
    "sandbox": "https://sandbox.safaricom.co.ke",
    "live": "https://api.safaricom.co.ke",
}

OAUTH_PATH = "/oauth/v1/generate?grant_type=client_credentials"
STK_PUSH_PATH = "/mpesa/stkpush/v1/processrequest"
STK_QUERY_PATH = "/mpesa/stkpushquery/v1/query"
C2B_REGISTER_PATH = "/mpesa/c2b/v1/registerurl"
C2B_SIMULATE_PATH = "/mpesa/c2b/v1/simulate"
B2C_PATH = "/mpesa/b2c/v1/paymentrequest"
B2B_PATH = "/mpesa/b2b/v1/paymentrequest"
TRANSACTION_STATUS_PATH = "/mpesa/transactionstatus/v1/query"
ACCOUNT_BALANCE_PATH = "/mpesa/accountbalance/v1/query"
REVERSAL_PATH = "/mpesa/reversal/v1/request"

# Calls whose submission is idempotent — safe to retry after a transport
# failure because they ask a question or re-declare config, they don't move
# money. Anything not listed here is sent exactly once per attempt.
RETRYABLE_PATHS = (
    OAUTH_PATH.split("?")[0],
    STK_QUERY_PATH,
    TRANSACTION_STATUS_PATH,
    ACCOUNT_BALANCE_PATH,
    C2B_REGISTER_PATH,
)

TIMEOUT_SECONDS = 15
TOKEN_REFRESH_MARGIN = 60
RETRY_BACKOFF = (0.5, 1.5)
MAX_ATTEMPTS = 3

_TOKEN_CACHE = {}
_TOKEN_LOCK = threading.Lock()


class DarajaError(Exception):
    """Daraja answered with an error or could not be reached."""

    def __init__(self, message, status=None, code=None):
        super().__init__(message)
        self.status = status
        self.code = code


class DarajaTimeout(DarajaError):
    """The request left us but the outcome is unknown — resolve via
    Transaction Status, never by resubmitting."""


def normalize_msisdn(value):
    """Kenyan MSISDN -> 2547XXXXXXXX or 2541XXXXXXXX, else raise."""
    digits = re.sub(r"\D", "", str(value or ""))
    if digits.startswith("00254"):
        digits = digits[2:]
    if digits.startswith("0") and len(digits) == 10:
        digits = "254" + digits[1:]
    if digits.startswith("7") or digits.startswith("1"):
        if len(digits) == 9:
            digits = "254" + digits
    if len(digits) != 12 or not digits.startswith("254") or digits[3] not in "17":
        raise DarajaError("That is not a Kenyan mobile number.")
    return digits


def mask_msisdn(value):
    """2547•••••123 — recognisable, never dialable."""
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) < 8:
        return "••••" if digits else ""
    return digits[:4] + "•" * (len(digits) - 7) + digits[-3:]


def validate_shortcode(value, what="shortcode"):
    digits = str(value or "").strip()
    if not digits.isdigit() or not 4 <= len(digits) <= 10:
        raise DarajaError(f"That is not a valid {what}.")
    return digits


def whole_shillings(value):
    """M-Pesa amounts are whole shillings; never charge less than quoted."""
    try:
        return max(1, int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP)))
    except (InvalidOperation, ValueError) as error:
        raise DarajaError("That is not a valid amount.") from error


def default_transport(url, headers, body, timeout):
    request = urllib.request.Request(url, data=body, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def security_credential(initiator_password, cert_pem):
    """RSA-encrypt the initiator password with Safaricom's public certificate."""
    from cryptography import x509
    from cryptography.hazmat.primitives.asymmetric import padding

    if not initiator_password:
        raise DarajaError("No initiator password is configured.")
    if not cert_pem:
        raise DarajaError("No Safaricom certificate is configured for this environment.")
    certificate = x509.load_pem_x509_certificate(cert_pem)
    sealed = certificate.public_key().encrypt(
        initiator_password.encode("utf-8"), padding.PKCS1v15()
    )
    return base64.b64encode(sealed).decode()


class DarajaConfig:
    """Everything one Daraja identity needs. Build from a settings row or
    fill the fields directly; secrets stay server-side throughout."""

    def __init__(
        self,
        environment,
        consumer_key,
        consumer_secret,
        short_code="",
        passkey="",
        account_type="paybill",
        initiator_name="",
        initiator_password="",
        payout_shortcode="",
    ):
        if environment not in HOSTS:
            raise DarajaError("Unknown Daraja environment.")
        self.environment = environment
        self.consumer_key = str(consumer_key or "")
        self.consumer_secret = str(consumer_secret or "")
        self.short_code = str(short_code or "")
        self.passkey = str(passkey or "")
        self.account_type = account_type or "paybill"
        self.initiator_name = str(initiator_name or "")
        self.initiator_password = str(initiator_password or "")
        self.payout_shortcode = str(payout_shortcode or "")

    @property
    def host(self):
        return HOSTS[self.environment]

    @property
    def pay_shortcode(self):
        return self.payout_shortcode or self.short_code


class DarajaClient:
    def __init__(self, config, transport=None, clock=None, sleep=None, timeout=TIMEOUT_SECONDS):
        self.config = config
        self.transport = transport or default_transport
        self.clock = clock or time.time
        self.sleep = sleep or time.sleep
        self.timeout = timeout
        self._cert_cache = None

    # --- transport -----------------------------------------------------------

    def _send(self, url, headers, body, retry):
        attempts = MAX_ATTEMPTS if retry else 1
        last_error = None
        for attempt in range(attempts):
            if attempt:
                self.sleep(RETRY_BACKOFF[min(attempt - 1, len(RETRY_BACKOFF) - 1)])
            try:
                status, raw = self.transport(url, headers, body, self.timeout)
            except Exception as error:  # connection refused, DNS, TLS, timeout
                last_error = error
                continue
            if status < 400:
                try:
                    return json.loads(raw.decode() or "{}")
                except ValueError as error:
                    raise DarajaError("Daraja returned a response that was not JSON.", status=status) from error
            if 400 <= status < 500 or not retry or attempt == attempts - 1:
                code, description = _error_body(raw)
                if status in (401, 403):
                    self._drop_token()
                raise DarajaError(description or f"Daraja answered with an error ({status}).", status=status, code=code)
            last_error = DarajaError(f"Daraja answered with an error ({status}).", status=status)
        raise DarajaTimeout(
            "Daraja could not be reached — the outcome is unknown and must be verified, not retried."
        ) from last_error

    def _post(self, path, payload, retry=None, auth=True):
        retry = (path in RETRYABLE_PATHS) if retry is None else retry
        headers = {"Content-Type": "application/json"}
        if auth:
            headers["Authorization"] = f"Bearer {self.token()}"
        return self._send(f"{self.config.host}{path}", headers, json.dumps(payload).encode(), retry)

    # --- oauth ---------------------------------------------------------------

    def _drop_token(self):
        with _TOKEN_LOCK:
            _TOKEN_CACHE.pop((self.config.environment, self.config.consumer_key), None)

    def token(self):
        """Cached OAuth token per (environment, consumer key)."""
        key = (self.config.environment, self.config.consumer_key)
        with _TOKEN_LOCK:
            cached = _TOKEN_CACHE.get(key)
        if cached and cached[1] > self.clock() + TOKEN_REFRESH_MARGIN:
            return cached[0]
        auth = base64.b64encode(
            f"{self.config.consumer_key}:{self.config.consumer_secret}".encode()
        ).decode()
        body = self._send(
            f"{self.config.host}{OAUTH_PATH}",
            {"Authorization": f"Basic {auth}"},
            None,
            retry=True,
        )
        token = body.get("access_token")
        if not token:
            raise DarajaError("Daraja did not return an access token.")
        expires = int(body.get("expires_in") or 3600)
        with _TOKEN_LOCK:
            _TOKEN_CACHE[key] = (token, self.clock() + expires)
        return token

    # --- security credential --------------------------------------------------

    def _cert_pem(self):
        """Safaricom public cert for this environment — a PEM file path or
        inline PEM in ISP_DARAJA_CERT_SANDBOX / ISP_DARAJA_CERT_LIVE."""
        if self._cert_cache is None:
            env = "LIVE" if self.config.environment == "live" else "SANDBOX"
            setting = (os.environ.get(f"ISP_DARAJA_CERT_{env}") or "").strip()
            if not setting:
                self._cert_cache = b""
            elif setting.startswith("-----BEGIN"):
                self._cert_cache = setting.encode()
            else:
                with open(setting, "rb") as handle:
                    self._cert_cache = handle.read()
        return self._cert_cache

    def _credential(self):
        if not self.config.initiator_name:
            raise DarajaError("No initiator name is configured.")
        return security_credential(self.config.initiator_password, self._cert_pem())

    def _secured(self):
        return {
            "Initiator": self.config.initiator_name,
            "SecurityCredential": self._credential(),
        }

    # --- collections ----------------------------------------------------------

    def _stk_auth(self):
        stamp_now = datetime.now().strftime("%Y%m%d%H%M%S")
        shortcode = validate_shortcode(self.config.short_code, "business shortcode")
        password = base64.b64encode(f"{shortcode}{self.config.passkey}{stamp_now}".encode()).decode()
        return shortcode, password, stamp_now

    def stk_push(self, phone, amount, reference, callback_url, description="Internet recharge"):
        shortcode, password, stamp_now = self._stk_auth()
        payload = {
            "BusinessShortCode": shortcode,
            "Password": password,
            "Timestamp": stamp_now,
            "TransactionType": "CustomerPayBillOnline"
            if self.config.account_type == "paybill"
            else "CustomerBuyGoodsOnline",
            "Amount": whole_shillings(amount),
            "PartyA": normalize_msisdn(phone),
            "PartyB": shortcode,
            "PhoneNumber": normalize_msisdn(phone),
            "CallBackURL": callback_url,
            "AccountReference": str(reference or "")[:12],
            "TransactionDesc": str(description or "")[:20],
        }
        return self._post(STK_PUSH_PATH, payload, retry=False)

    def stk_query(self, checkout_id):
        shortcode, password, stamp_now = self._stk_auth()
        return self._post(
            STK_QUERY_PATH,
            {
                "BusinessShortCode": shortcode,
                "Password": password,
                "Timestamp": stamp_now,
                "CheckoutRequestID": str(checkout_id or ""),
            },
        )

    def c2b_register(self, confirmation_url, validation_url, response_type="Completed"):
        if response_type not in ("Completed", "Cancelled"):
            raise DarajaError("C2B response type must be Completed or Cancelled.")
        return self._post(
            C2B_REGISTER_PATH,
            {
                "ShortCode": validate_shortcode(self.config.short_code, "business shortcode"),
                "ResponseType": response_type,
                "ConfirmationURL": confirmation_url,
                "ValidationURL": validation_url,
            },
        )

    def c2b_simulate(self, amount, phone, bill_reference=""):
        """Sandbox only — production C2B traffic comes from real subscribers."""
        if self.config.environment != "sandbox":
            raise DarajaError("C2B simulation only exists on the sandbox.")
        payload = {
            "ShortCode": validate_shortcode(self.config.short_code, "business shortcode"),
            "CommandID": "CustomerPayBillOnline"
            if self.config.account_type == "paybill"
            else "CustomerBuyGoodsOnline",
            "Amount": whole_shillings(amount),
            "Msisdn": normalize_msisdn(phone),
        }
        if payload["CommandID"] == "CustomerPayBillOnline":
            payload["BillRefNumber"] = str(bill_reference or "")[:12]
        return self._post(C2B_SIMULATE_PATH, payload, retry=False)

    # --- payouts --------------------------------------------------------------

    def _payout_urls(self, result_url, timeout_url):
        if not str(result_url or "").startswith("https://") or not str(timeout_url or "").startswith("https://"):
            raise DarajaError("Payout result and timeout URLs must be https.")
        return {"ResultURL": result_url, "QueueTimeOutURL": timeout_url}

    def b2c(self, phone, amount, result_url, timeout_url, remarks="Payout", occasion="", command_id="BusinessPayment"):
        """Send money to a phone. Never auto-retried — a transport failure is
        resolved via Transaction Status on the returned/expected ids."""
        if command_id not in ("BusinessPayment", "SalaryPayment", "PromotionPayment"):
            raise DarajaError("Unknown B2C command.")
        payload = {
            "InitiatorName": self.config.initiator_name,
            "SecurityCredential": self._credential(),
            "CommandID": command_id,
            "Amount": whole_shillings(amount),
            "PartyA": validate_shortcode(self.config.pay_shortcode, "payout shortcode"),
            "PartyB": normalize_msisdn(phone),
            "Remarks": str(remarks or "")[:100],
            "Occassion": str(occasion or "")[:100],
            **self._payout_urls(result_url, timeout_url),
        }
        return self._post(B2C_PATH, payload, retry=False)

    def _b2b(self, command_id, party_b, amount, result_url, timeout_url, remarks, account_reference):
        payload = {
            **self._secured(),
            "CommandID": command_id,
            "SenderIdentifierType": "4",
            "RecieverIdentifierType": "4",
            "Amount": whole_shillings(amount),
            "PartyA": validate_shortcode(self.config.pay_shortcode, "payout shortcode"),
            "PartyB": validate_shortcode(party_b, "destination shortcode"),
            "Remarks": str(remarks or "")[:100],
            **self._payout_urls(result_url, timeout_url),
        }
        if account_reference:
            payload["AccountReference"] = str(account_reference)[:13]
        return self._post(B2B_PATH, payload, retry=False)

    def b2b_paybill(self, paybill, amount, account_reference, result_url, timeout_url, remarks="Settlement"):
        """BusinessPayBill — pays a paybill destination, always with an
        account reference so the ISP can reconcile."""
        return self._b2b(
            "BusinessPayBill", paybill, amount, result_url, timeout_url, remarks, account_reference
        )

    def b2b_buygoods(self, till, amount, result_url, timeout_url, remarks="Settlement"):
        """BusinessBuyGoods — pays a till destination."""
        return self._b2b("BusinessBuyGoods", till, amount, result_url, timeout_url, remarks, None)

    # --- verification & ops -----------------------------------------------------

    def transaction_status(self, transaction_id=None, result_url="", timeout_url="",
                           remarks="Status check", original_conversation_id=None):
        """Query by M-Pesa TransactionID, or by the OriginatorConversationID
        we stored at submission when no receipt exists yet."""
        payload = {
            **self._secured(),
            "CommandID": "TransactionStatusQuery",
            "PartyA": validate_shortcode(self.config.pay_shortcode, "shortcode"),
            "IdentifierType": "4",
            "Remarks": str(remarks or "")[:100],
            **self._payout_urls(result_url, timeout_url),
        }
        if original_conversation_id:
            payload["OriginalConversationID"] = str(original_conversation_id)[:64]
        else:
            payload["TransactionID"] = str(transaction_id or "")
        return self._post(TRANSACTION_STATUS_PATH, payload)

    def account_balance(self, result_url, timeout_url, remarks="Balance query"):
        payload = {
            **self._secured(),
            "CommandID": "AccountBalance",
            "PartyA": validate_shortcode(self.config.pay_shortcode, "shortcode"),
            "IdentifierType": "4",
            "Remarks": str(remarks or "")[:100],
            **self._payout_urls(result_url, timeout_url),
        }
        return self._post(ACCOUNT_BALANCE_PATH, payload)

    def reversal(self, transaction_id, amount, result_url, timeout_url, remarks="Reversal"):
        payload = {
            **self._secured(),
            "CommandID": "TransactionReversal",
            "TransactionID": str(transaction_id or ""),
            "Amount": whole_shillings(amount),
            "ReceiverParty": validate_shortcode(self.config.pay_shortcode, "shortcode"),
            "RecieverIdentifierType": "4",
            "Remarks": str(remarks or "")[:100],
            **self._payout_urls(result_url, timeout_url),
        }
        return self._post(REVERSAL_PATH, payload, retry=False)


def _error_body(raw):
    """Pull errorCode/errorMessage out of a Daraja error response."""
    try:
        body = json.loads(raw.decode() or "{}")
    except (ValueError, AttributeError):
        return None, None
    code = body.get("errorCode") or body.get("ResponseCode") or body.get("ResultCode")
    description = (
        body.get("errorMessage")
        or body.get("ResponseDescription")
        or body.get("ResultDesc")
    )
    return code, description


def accepted(body):
    """Daraja's synchronous ack — the real result still arrives on ResultURL."""
    return str((body or {}).get("ResponseCode", "")) == "0"
