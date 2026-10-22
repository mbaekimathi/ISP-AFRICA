"""AES-GCM sealing for the company gateway's stored secrets.

The pooled-collection gateway holds the company's Daraja consumer secret,
passkey, initiator password, and callback secret. Those are sealed with
AES-256-GCM using a dedicated key that never touches the database:

  ISP_GATEWAY_SECRET        key material for the CURRENT sealing key.
  ISP_GATEWAY_KEY_ID        id stamped into new envelopes (default "g1").
  ISP_GATEWAY_SECRETS_OLD   "id=secret;id2=secret2" retired keys that must
                            still decrypt existing rows.

Envelope format:  gcm1.<key_id>.<base64(nonce || ciphertext || tag)>

When ISP_GATEWAY_SECRET is unset in production, new values are sealed under
key id "s1" with key material from ISP_ROUTER_SECRET (or
ISP_ACCOUNT_CODE_SECRET), so saving payment settings keeps working. Setting
ISP_GATEWAY_SECRET later switches new writes to it; "s1" rows keep opening
for as long as that server secret stays unchanged.

Rotation: set a new ISP_GATEWAY_KEY_ID + ISP_GATEWAY_SECRET and move the old
pair into ISP_GATEWAY_SECRETS_OLD. New writes use the new key; old rows keep
decrypting until they are re-sealed.

The legacy seal_password cipher is intentionally left alone — it protects
router API passwords and older payment settings, not the gateway fields.
"""

import base64
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

ENVELOPE_VERSION = "gcm1"
DEFAULT_KEY_ID = "g1"
SERVER_KEY_ID = "s1"
DEV_KEY_MATERIAL = "isp-gateway-development-key"

_warned = False


class GatewayCryptoError(Exception):
    """Raised when sealing or opening a gateway secret cannot proceed."""


def _server_material():
    return (
        (os.environ.get("ISP_ROUTER_SECRET") or "").strip()
        or (os.environ.get("ISP_ACCOUNT_CODE_SECRET") or "").strip()
    )


def current_key_id():
    explicit = (os.environ.get("ISP_GATEWAY_KEY_ID") or "").strip()
    if explicit:
        return explicit
    if (
        os.environ.get("ISP_ENV") == "production"
        and not (os.environ.get("ISP_GATEWAY_SECRET") or "").strip()
        and _server_material()
    ):
        return SERVER_KEY_ID
    return DEFAULT_KEY_ID


def _parse_old(text):
    ring = {}
    for pair in str(text or "").split(";"):
        pair = pair.strip()
        key_id, sep, secret = pair.partition("=")
        if sep and key_id.strip() and secret.strip():
            ring[key_id.strip()] = secret.strip()
    return ring


def _keyring():
    ring = {}
    server = _server_material()
    if server:
        ring[SERVER_KEY_ID] = server
    ring.update(_parse_old(os.environ.get("ISP_GATEWAY_SECRETS_OLD")))
    current = (os.environ.get("ISP_GATEWAY_SECRET") or "").strip()
    if current:
        ring[current_key_id()] = current
    return ring


def _material_for(key_id):
    material = _keyring().get(key_id)
    if material:
        return material
    if key_id == current_key_id():
        global _warned
        if os.environ.get("ISP_ENV") == "production":
            raise GatewayCryptoError(
                "No sealing key is configured on the server. Set ISP_GATEWAY_SECRET "
                "(or ISP_ROUTER_SECRET) in .env and restart the service."
            )
        if not _warned:
            _warned = True
            print(
                "event=gateway-crypto warning=dev-key "
                "detail=ISP_GATEWAY_SECRET unset; using a fixed development key.",
                flush=True,
            )
        return DEV_KEY_MATERIAL
    raise GatewayCryptoError("Unknown gateway key id — the row cannot be opened.")


def _derive(material):
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"isp-centric-gateway-v1",
        info=b"daraja-secrets",
    ).derive(material.encode())


def is_sealed(value):
    return str(value or "").startswith(f"{ENVELOPE_VERSION}.")


def seal(value):
    """Seal a secret into a versioned envelope. Empty values pass through."""
    if not value:
        return value
    if is_sealed(value):
        return str(value)
    key_id = current_key_id()
    key = _derive(_material_for(key_id))
    nonce = os.urandom(12)
    body = AESGCM(key).encrypt(nonce, str(value).encode("utf-8"), None)
    return f"{ENVELOPE_VERSION}.{key_id}.{base64.b64encode(nonce + body).decode()}"


def open_secret(value):
    """Open an envelope. Plaintext rows pass through so legacy data still works."""
    if not value:
        return value
    text = str(value)
    parts = text.split(".", 2)
    if len(parts) != 3 or parts[0] != ENVELOPE_VERSION:
        return text
    _, key_id, packed = parts
    try:
        raw = base64.b64decode(packed)
    except (ValueError, TypeError):
        raise GatewayCryptoError("The sealed gateway secret is malformed.")
    if len(raw) <= 12:
        raise GatewayCryptoError("The sealed gateway secret is malformed.")
    key = _derive(_material_for(key_id))
    try:
        return AESGCM(key).decrypt(raw[:12], raw[12:], None).decode("utf-8")
    except Exception as error:
        raise GatewayCryptoError("The sealed gateway secret failed its integrity check.") from error
