"""Minimal Web Push sender — no third-party push library needed.

RFC 8291: message encryption (aes128gcm content coding, single record).
RFC 8292: VAPID voluntary identification (ES256-signed JWT).

A push subscription outlives the login that created it — the browser's push
service wakes the service worker and shows an OS notification (with sound)
even when nobody is signed in on that gadget.
"""

import base64
import json
import os
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

RECORD_SIZE = 4096
TTL_SECONDS = 86400


def _b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64url(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def generate_vapid_keys():
    """A fresh (public, private) VAPID keypair, both base64url-encoded."""
    private = ec.generate_private_key(ec.SECP256R1())
    public = private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    private_bytes = private.private_numbers().private_value.to_bytes(32, "big")
    return _b64url(public), _b64url(private_bytes)


def _vapid_jwt(endpoint, public_key, private_key, subject):
    origin = urlparse(endpoint)
    header = _b64url(json.dumps({"typ": "JWT", "alg": "ES256"}).encode())
    claims = _b64url(
        json.dumps(
            {
                "aud": f"{origin.scheme}://{origin.netloc}",
                "exp": int(time.time()) + 12 * 60 * 60,
                "sub": subject,
            }
        ).encode()
    )
    signing_input = f"{header}.{claims}".encode()
    private = ec.derive_private_key(
        int.from_bytes(_unb64url(private_key), "big"), ec.SECP256R1()
    )
    r, s = decode_dss_signature(private.sign(signing_input, ec.ECDSA(hashes.SHA256())))
    signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return f"{header}.{claims}.{_b64url(signature)}"


def _hkdf(salt, ikm, info, length):
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def _encrypt(payload, p256dh, auth_secret):
    """Encrypt one push message for one subscription (aes128gcm)."""
    ua_public_bytes = _unb64url(p256dh)
    auth = _unb64url(auth_secret)
    ua_public = ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP256R1(), ua_public_bytes
    )
    as_private = ec.generate_private_key(ec.SECP256R1())
    as_public_bytes = as_private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    shared_secret = as_private.exchange(ec.ECDH(), ua_public)
    ikm = _hkdf(
        auth,
        shared_secret,
        b"WebPush: info\x00" + ua_public_bytes + as_public_bytes,
        32,
    )
    salt = os.urandom(16)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    ciphertext = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    return (
        salt
        + RECORD_SIZE.to_bytes(4, "big")
        + bytes([len(as_public_bytes)])
        + as_public_bytes
        + ciphertext
    )


def send_push(endpoint, p256dh, auth, payload, vapid_public, vapid_private, subject):
    """POST an encrypted push message. Returns (http_status, detail) — status
    is None on a network failure, 201/202 on acceptance, 404/410 when the
    subscription is gone for good."""
    jwt = _vapid_jwt(endpoint, vapid_public, vapid_private, subject)
    request = urllib.request.Request(
        endpoint,
        data=_encrypt(payload.encode(), p256dh, auth),
        method="POST",
        headers={
            "Authorization": f"vapid t={jwt},k={vapid_public}",
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "TTL": str(TTL_SECONDS),
            "Urgency": "high",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, ""
    except urllib.error.HTTPError as error:
        try:
            detail = error.read().decode("utf-8", "replace")[:200]
        except OSError:
            detail = ""
        return error.code, detail
    except (urllib.error.URLError, OSError) as error:
        return None, str(getattr(error, "reason", error))
