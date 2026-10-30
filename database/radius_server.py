"""Minimal RADIUS authentication and accounting server.

Listens on UDP 1812 and 1813 so MikroTik routers can authenticate PPPoE
subscribers against the radcheck/radreply/radusergroup/radgroupreply
tables this application maintains. No external FreeRADIUS install is
needed; the NAS shared secret comes from the `nas` table, keyed by the
router address that sends the packet.
"""

import hashlib
import hmac
import os
import secrets
import socket
import struct
import threading
import time

import pymysql

import pppoe_service
import pppoe_store

AUTH_PORT = int(os.environ.get("ISP_RADIUS_AUTH_PORT") or 1812)
ACCT_PORT = int(os.environ.get("ISP_RADIUS_ACCT_PORT") or 1813)
STATUS = {}

VENDOR_MICROSOFT = 311
VENDOR_MIKROTIK = 14988

ACCESS_REQUEST = 1
ACCESS_ACCEPT = 2
ACCESS_REJECT = 3
ACCOUNTING_REQUEST = 4
ACCOUNTING_RESPONSE = 5
DISCONNECT_ACK = 41

STATUS_START = 1
STATUS_STOP = 2
STATUS_INTERIM = 3

# attribute name -> (number, kind)
REPLY_ATTRS = {
    "Framed-IP-Address": (8, "ipaddr"),
    "Reply-Message": (18, "string"),
    "Session-Timeout": (27, "integer"),
    "Idle-Timeout": (28, "integer"),
    "Acct-Interim-Interval": (85, "integer"),
    "Framed-Pool": (88, "string"),
    "Framed-Protocol": (7, "integer"),
    "Service-Type": (6, "integer"),
}
# attribute name -> (vendor, vendor-type, kind)
VENDOR_ATTRS = {
    "Mikrotik-Rate-Limit": (VENDOR_MIKROTIK, 8, "string"),
    "Mikrotik-Address-List": (VENDOR_MIKROTIK, 19, "string"),
}
MS_CHAP_RESPONSE = 1
MS_CHAP_ERROR = 2
MS_CHAP_CHALLENGE = 11
MS_CHAP2_RESPONSE = 25
MS_CHAP2_SUCCESS = 26

MAGIC1 = b"Magic server to client signing constant"
MAGIC2 = b"Pad to make it do more than one iteration"

TERMINATE_CAUSES = {
    1: "user-request",
    2: "lost-carrier",
    3: "lost-service",
    4: "idle-timeout",
    5: "session-timeout",
    6: "admin-reset",
    7: "admin-reboot",
    8: "port-error",
    9: "nas-error",
    10: "nas-request",
    11: "nas-reboot",
    12: "port-unneeded",
    13: "port-preempted",
    14: "port-suspended",
    15: "service-unavailable",
    16: "callback",
    17: "user-error",
    18: "host-request",
}


def md4(data):
    """RFC 1320 MD4. OpenSSL no longer ships it, but MS-CHAP needs NT hashes."""
    message = bytearray(data)
    bit_length = (len(message) * 8) & 0xFFFFFFFFFFFFFFFF
    message.append(0x80)
    while len(message) % 64 != 56:
        message.append(0)
    message += bit_length.to_bytes(8, "little")
    a, b, c, d = 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476

    def rol(value, count):
        value &= 0xFFFFFFFF
        return ((value << count) | (value >> (32 - count))) & 0xFFFFFFFF

    f = lambda x, y, z: (x & y) | (~x & z)
    g = lambda x, y, z: (x & y) | (x & z) | (y & z)
    h = lambda x, y, z: x ^ y ^ z
    round2_order = [(index % 4) * 4 + index // 4 for index in range(16)]
    round3_order = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15]
    for offset in range(0, len(message), 64):
        words = [int.from_bytes(message[offset + 4 * i: offset + 4 * i + 4], "little") for i in range(16)]
        x, y, z, w = a, b, c, d
        for i in range(16):
            shift = (3, 7, 11, 19)[i % 4]
            if i % 4 == 0:
                x = rol(x + f(y, z, w) + words[i], shift)
            elif i % 4 == 1:
                w = rol(w + f(x, y, z) + words[i], shift)
            elif i % 4 == 2:
                z = rol(z + f(w, x, y) + words[i], shift)
            else:
                y = rol(y + f(z, w, x) + words[i], shift)
        for i in range(16):
            shift = (3, 5, 9, 13)[i % 4]
            if i % 4 == 0:
                x = rol(x + g(y, z, w) + words[round2_order[i]] + 0x5A827999, shift)
            elif i % 4 == 1:
                w = rol(w + g(x, y, z) + words[round2_order[i]] + 0x5A827999, shift)
            elif i % 4 == 2:
                z = rol(z + g(w, x, y) + words[round2_order[i]] + 0x5A827999, shift)
            else:
                y = rol(y + g(z, w, x) + words[round2_order[i]] + 0x5A827999, shift)
        for i in range(16):
            shift = (3, 9, 11, 15)[i % 4]
            if i % 4 == 0:
                x = rol(x + h(y, z, w) + words[round3_order[i]] + 0x6ED9EBA1, shift)
            elif i % 4 == 1:
                w = rol(w + h(x, y, z) + words[round3_order[i]] + 0x6ED9EBA1, shift)
            elif i % 4 == 2:
                z = rol(z + h(w, x, y) + words[round3_order[i]] + 0x6ED9EBA1, shift)
            else:
                y = rol(y + h(z, w, x) + words[round3_order[i]] + 0x6ED9EBA1, shift)
        a = (a + x) & 0xFFFFFFFF
        b = (b + y) & 0xFFFFFFFF
        c = (c + z) & 0xFFFFFFFF
        d = (d + w) & 0xFFFFFFFF
    return struct.pack("<4I", a, b, c, d)


def nt_hash(password):
    return md4(str(password).encode("utf-16-le"))


def _des_key(key7):
    """Expand a 7-byte key into an 8-byte DES key with parity."""
    expanded = bytearray(8)
    expanded[0] = key7[0] & 0xFE
    expanded[1] = ((key7[0] << 7) | (key7[1] >> 1)) & 0xFE
    expanded[2] = ((key7[1] << 6) | (key7[2] >> 2)) & 0xFE
    expanded[3] = ((key7[2] << 5) | (key7[3] >> 3)) & 0xFE
    expanded[4] = ((key7[3] << 4) | (key7[4] >> 4)) & 0xFE
    expanded[5] = ((key7[4] << 3) | (key7[5] >> 5)) & 0xFE
    expanded[6] = ((key7[5] << 2) | (key7[6] >> 6)) & 0xFE
    expanded[7] = (key7[6] << 1) & 0xFE
    for index in range(8):
        if bin(expanded[index]).count("1") % 2 == 0:
            expanded[index] |= 1
    return bytes(expanded)


def _des_encrypt(key7, block):
    try:
        from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES
    except ImportError:
        from cryptography.hazmat.primitives.ciphers.algorithms import TripleDES
    from cryptography.hazmat.primitives.ciphers import Cipher, modes

    key8 = _des_key(key7)
    cipher = Cipher(TripleDES(key8 + key8 + key8), modes.ECB())
    encryptor = cipher.encryptor()
    return encryptor.update(block) + encryptor.finalize()


def challenge_response(challenge8, password_hash16):
    padded = password_hash16 + b"\x00" * 5
    return (
        _des_encrypt(padded[0:7], challenge8)
        + _des_encrypt(padded[7:14], challenge8)
        + _des_encrypt(padded[14:21], challenge8)
    )


def mschap2_authenticator(password_hash16, nt_response, challenge8):
    hash_hash = nt_hash_from_hash(password_hash16)
    digest = hashlib.sha1(hash_hash + nt_response + MAGIC1).digest()
    return hashlib.sha1(digest + challenge8 + MAGIC2).hexdigest().upper()


def nt_hash_from_hash(password_hash16):
    return md4(password_hash16)


def parse_packet(data):
    if len(data) < 20:
        return None
    code, ident, length = struct.unpack(">BBH", data[:4])
    if length < 20 or length > len(data):
        return None
    authenticator = data[4:20]
    attributes = {}
    vendor = {}
    position = 20
    while position + 2 <= length:
        attr_type, attr_len = data[position], data[position + 1]
        if attr_len < 2 or position + attr_len > length:
            break
        value = data[position + 2: position + attr_len]
        if attr_type == 26 and len(value) >= 5:
            vendor_id = struct.unpack(">I", value[:4])[0]
            sub = value[4:]
            inner = []
            cursor = 0
            while cursor + 2 <= len(sub):
                v_type, v_len = sub[cursor], sub[cursor + 1]
                if v_len < 2 or cursor + v_len > len(sub):
                    break
                inner.append((v_type, sub[cursor + 2: cursor + v_len]))
                cursor += v_len
            vendor.setdefault(vendor_id, []).extend(inner)
        else:
            attributes.setdefault(attr_type, []).append(value)
        position += attr_len
    return {"code": code, "id": ident, "auth": authenticator, "raw": data[:length], "attrs": attributes, "vendor": vendor}


def attr_text(attributes, number):
    values = attributes.get(number)
    return values[0].decode("utf-8", "replace") if values else ""


def attr_int(attributes, number):
    values = attributes.get(number)
    return struct.unpack(">I", values[0])[0] if values and len(values[0]) == 4 else 0


def vendor_attr(vendor, vendor_id, v_type):
    values = vendor.get(vendor_id)
    if not values:
        return None
    for kind, value in values:
        if kind == v_type:
            return value
    return None


def encode_attr(number, value):
    return bytes([number, len(value) + 2]) + value


def encode_attrs(attribute, kind, value):
    if kind == "integer":
        raw = struct.pack(">I", int(value))
    elif kind == "ipaddr":
        raw = socket.inet_aton(str(value))
    else:
        raw = str(value).encode("utf-8")
    return encode_attr(attribute, raw)


def encode_vsa(vendor_id, v_type, raw):
    inner = encode_attr(v_type, raw)
    return encode_attr(26, struct.pack(">I", vendor_id) + inner)


def build_response(code, ident, request_auth, secret, attrs, with_ma=False):
    if with_ma:
        attrs += encode_attr(80, bytes(16))
        length = 20 + len(attrs)
        head = struct.pack(">BBH", code, ident, length) + request_auth
        digest = hmac.new(secret.encode(), head + attrs, hashlib.md5).digest()
        attrs = attrs[:-18] + encode_attr(80, digest)
    length = 20 + len(attrs)
    head = struct.pack(">BBH", code, ident, length) + request_auth
    authenticator = hashlib.md5(head + attrs + secret.encode()).digest()
    return struct.pack(">BBH", code, ident, length) + authenticator + attrs


def decode_user_password(value, secret, request_auth):
    plain = b""
    previous = request_auth
    for offset in range(0, len(value), 16):
        block = value[offset: offset + 16]
        if len(block) < 16:
            break
        digest = hashlib.md5(secret.encode() + previous).digest()
        plain += bytes(left ^ right for left, right in zip(digest, block))
        previous = block
    return plain.split(b"\x00")[0]


def verify_password(packet, secret, cleartext):
    """Return (ok, extra_attrs) for the authentication flavour the client used."""
    attrs = packet["attrs"]
    ms_chap2 = vendor_attr(packet["vendor"], VENDOR_MICROSOFT, MS_CHAP2_RESPONSE)
    if ms_chap2 is not None and len(ms_chap2) >= 50:
        server_challenge = vendor_attr(packet["vendor"], VENDOR_MICROSOFT, MS_CHAP_CHALLENGE) or packet["auth"]
        peer_challenge = ms_chap2[2:18]
        nt_response = ms_chap2[26:50]
        ident_byte = ms_chap2[0]
        username = attr_text(attrs, 1)
        challenge = hashlib.sha1(peer_challenge + server_challenge + username.encode()).digest()[:8]
        password_hash = nt_hash(cleartext)
        if challenge_response(challenge, password_hash) != nt_response:
            return False, b""
        proof = mschap2_authenticator(password_hash, nt_response, challenge)
        success = bytes([ident_byte]) + b"S=" + proof.encode()
        return True, encode_vsa(VENDOR_MICROSOFT, MS_CHAP2_SUCCESS, success)
    ms_chap1 = vendor_attr(packet["vendor"], VENDOR_MICROSOFT, MS_CHAP_RESPONSE)
    if ms_chap1 is not None and len(ms_chap1) >= 50:
        server_challenge = vendor_attr(packet["vendor"], VENDOR_MICROSOFT, MS_CHAP_CHALLENGE) or packet["auth"]
        nt_response = ms_chap1[26:50]
        expected = challenge_response(server_challenge[:8], nt_hash(cleartext))
        return expected == nt_response, b""
    chap = attrs.get(3)
    if chap and len(chap[0]) == 17:
        challenge = (attrs.get(60) or [packet["auth"]])[0]
        expected = hashlib.md5(bytes([chap[0][0]]) + cleartext.encode() + challenge).digest()
        return expected == chap[0][1:], b""
    user_password = attrs.get(2)
    if user_password:
        plain = decode_user_password(user_password[0], secret, packet["auth"])
        return plain == cleartext.encode(), b""
    return False, b""


_NAS_CACHE = {}
_NAS_LOCK = threading.Lock()
NAS_HIT_TTL = 60
NAS_MISS_TTL = 10
NAS_CACHE_MAX = 4096


def nas_cache_clear():
    """Drop cached secrets — called wherever nas rows are written so a new or
    rotated router secret is honored on the very next packet."""
    with _NAS_LOCK:
        _NAS_CACHE.clear()


def nas_secret(cursor, source_ip, packet):
    # The shared secret belongs to the peer that actually sent the packet.
    # NAS-IP-Address and NAS-Identifier are attacker-controlled fields inside
    # the packet and must never select a different router's secret.
    now = time.time()
    with _NAS_LOCK:
        cached = _NAS_CACHE.get(source_ip)
        if cached and cached[1] > now:
            return cached[0]
    cursor.execute("SELECT secret FROM nas WHERE nasname = %s LIMIT 1", (source_ip,))
    row = cursor.fetchone()
    secret = row["secret"] if row else None
    with _NAS_LOCK:
        if len(_NAS_CACHE) >= NAS_CACHE_MAX:
            for key, entry in list(_NAS_CACHE.items()):
                if entry[1] <= now:
                    del _NAS_CACHE[key]
        if len(_NAS_CACHE) < NAS_CACHE_MAX:
            _NAS_CACHE[source_ip] = (secret, now + (NAS_HIT_TTL if secret else NAS_MISS_TTL))
    return secret


def nas_routers(cursor, source_ip, packet):
    """Router ids the calling NAS belongs to — nas.description and isp_radius_nas both hold router ids."""
    names = [source_ip]
    marks = ", ".join(["%s"] * len(names))
    cursor.execute(
        f"""
        SELECT router_id FROM isp_radius_nas WHERE nasname IN ({marks})
        UNION
        SELECT description AS router_id FROM nas WHERE nasname IN ({marks}) AND description <> ''
        """,
        [*names, *names],
    )
    return {str(row["router_id"]) for row in cursor.fetchall() if row.get("router_id")}


def reply_attributes(cursor, username, extra):
    cursor.execute("SELECT attribute, op, value FROM radreply WHERE username = %s", (username,))
    replies = list(cursor.fetchall())
    cursor.execute("SELECT groupname FROM radusergroup WHERE username = %s ORDER BY priority", (username,))
    groups = [row["groupname"] for row in cursor.fetchall()]
    if groups:
        marks = ",".join(["%s"] * len(groups))
        cursor.execute(f"SELECT attribute, op, value FROM radgroupreply WHERE groupname IN ({marks})", groups)
        replies.extend(cursor.fetchall())
    encoded = b""
    for row in replies:
        name, value = row["attribute"], row["value"]
        if name in REPLY_ATTRS:
            number, kind = REPLY_ATTRS[name]
            try:
                encoded += encode_attrs(number, kind, value)
            except (OSError, ValueError):
                continue
        elif name in VENDOR_ATTRS:
            vendor_id, v_type, kind = VENDOR_ATTRS[name]
            encoded += encode_vsa(vendor_id, v_type, str(value).encode("utf-8"))
    return encoded + extra


STALE_SESSION_MINUTES = 15
# Rows on a confirmed-down NAS with no interim evidence are only retired after
# this much silence — a tunnel flap must not reap rows for clients still surfing.
DEAD_NAS_MINUTES = 45


def open_sessions(cursor, usernames):
    names = list(usernames)
    marks = ", ".join(["%s"] * len(names))
    cursor.execute(
        f"SELECT COUNT(*) AS open_count FROM radacct WHERE username IN ({marks}) AND acctstoptime IS NULL",
        names,
    )
    return int(cursor.fetchone()["open_count"])


def close_stale_sessions(cursor, usernames):
    """Sessions older than three interim-update gaps died without a Stop; close them so Simultaneous-Use cannot lock an account out."""
    names = list(usernames)
    marks = ", ".join(["%s"] * len(names))
    cursor.execute(
        f"""
        UPDATE radacct
        SET acctstoptime = COALESCE(acctupdatetime, acctstarttime),
            acctterminatecause = 'lost-service'
        WHERE username IN ({marks})
          AND acctstoptime IS NULL
          AND COALESCE(acctupdatetime, acctstarttime) < DATE_SUB(NOW(), INTERVAL %s MINUTE)
        """,
        [*names, STALE_SESSION_MINUTES],
    )


def sweep_stale_sessions(connect):
    """Globally retire radacct rows a dead NAS stranded.

    A powered-off router sends no Accounting-Stop, so without this sweep those
    rows keep subscribers showing 'surfing' forever. A row is only closed when
    the NAS provably went silent — either it sent interim updates that then
    stopped (acctupdatetime moved past acctstarttime, then aged out), or its
    management tunnel is confirmed 'down' for much longer than a flap. A
    session that never sent an interim update on a healthy or unknown NAS is
    left alone: interim updates may simply be disabled there, and a live client
    must never be dropped. If a row was closed wrongly the NAS's next interim
    update re-inserts it.
    """
    db = connect()
    try:
        with db.cursor() as cursor:
            cursor.execute(
                """
                UPDATE radacct a
                LEFT JOIN isp_mikrotik_devices d ON d.tunnel_ip = a.nasipaddress
                SET a.acctstoptime = COALESCE(a.acctupdatetime, a.acctstarttime),
                    a.acctterminatecause = 'lost-service'
                WHERE a.acctstoptime IS NULL
                  AND (
                        (a.acctupdatetime IS NOT NULL AND a.acctupdatetime > a.acctstarttime
                         AND a.acctupdatetime < DATE_SUB(NOW(), INTERVAL %s MINUTE))
                        OR (d.tunnel_status = 'down'
                            AND COALESCE(a.acctupdatetime, a.acctstarttime) < DATE_SUB(NOW(), INTERVAL %s MINUTE))
                  )
                """,
                (STALE_SESSION_MINUTES, DEAD_NAS_MINUTES),
            )
            if cursor.rowcount:
                print(f"event=radius-sweep stale-closed={cursor.rowcount}", flush=True)
    except Exception as error:
        print(f"event=radius-sweep error={error}", flush=True)
    finally:
        db.close()


def open_session_rows(cursor, usernames):
    names = list(usernames)
    marks = ", ".join(["%s"] * len(names))
    cursor.execute(
        f"""
        SELECT radacctid, username, nasipaddress, acctsessionid, framedipaddress
        FROM radacct
        WHERE username IN ({marks}) AND acctstoptime IS NULL
        ORDER BY acctstarttime
        """,
        names,
    )
    return list(cursor.fetchall())


def kick_sessions(cursor, rows):
    """Close the oldest open rows so a re-dialing subscriber is not locked out.

    No Disconnect-Request is sent from the auth path: a radacct row is only a
    guess about what the NAS holds, and after a router reboot a stale
    Acct-Session-Id can match a brand-new live session — a PoD built on that
    guess can kill a client that is legitimately surfing. A genuinely
    duplicated login is displaced by the PPP profile's only-one on the NAS
    itself, with no session-id guessing. Closing the row frees Simultaneous-Use
    and, if the old session really was live, its next interim update or Stop
    re-syncs the table."""
    ids = [row["radacctid"] for row in rows if row.get("radacctid") is not None]
    if ids:
        marks = ", ".join(["%s"] * len(ids))
        cursor.execute(
            f"UPDATE radacct SET acctstoptime = NOW(), acctterminatecause = 'superseded' WHERE radacctid IN ({marks}) AND acctstoptime IS NULL",
            ids,
        )


def _username_roots(username):
    """'user@realm' and 'DOMAIN\\user' should resolve to the same radcheck row as 'user'."""
    roots = [username]
    for root in (username.split("@", 1)[0], username.rsplit("\\", 1)[-1]):
        if root and root not in roots:
            roots.append(root)
    return roots


def authenticate(cursor, packet, source_ip):
    secret = nas_secret(cursor, source_ip, packet)
    if not secret:
        nas_ip = packet["attrs"].get(4)
        nas_hint = socket.inet_ntoa(nas_ip[0]) if nas_ip and len(nas_ip[0]) == 4 else ""
        print(f"event=radius-auth result=no-nas source={source_ip} nas-ip={nas_hint} nas-id={attr_text(packet['attrs'], 32)}", flush=True)
        return None
    username = attr_text(packet["attrs"], 1)
    if not username:
        return build_response(ACCESS_REJECT, packet["id"], packet["auth"], secret, b"", True)
    roots = _username_roots(username)
    candidates = pppoe_service.username_aliases(username)
    marks = ", ".join(["%s"] * len(candidates))
    cursor.execute(f"SELECT username, attribute, value FROM radcheck WHERE username IN ({marks})", candidates)
    by_user = {}
    for row in cursor.fetchall():
        by_user.setdefault(row["username"], {})[row["attribute"]] = row["value"]
    stored = next((name for name in candidates if name in by_user), "")
    checks = by_user.get(stored, {})
    cleartext = checks.get("Cleartext-Password")
    if checks.get("Auth-Type") == "Reject" or not cleartext:
        return build_response(ACCESS_REJECT, packet["id"], packet["auth"], secret, b"", True)
    # A subscriber credential only dials from the router it was provisioned on.
    # Check before touching session state so a copied login on another router
    # cannot kick or disturb the legitimate session.
    cursor.execute(
        "SELECT router_id FROM pppoe_subscribers WHERE pppoe_username = %s AND deleted = 0 LIMIT 1",
        (stored,),
    )
    owner = cursor.fetchone()
    if owner and owner.get("router_id") and str(owner["router_id"]) not in nas_routers(cursor, source_ip, packet):
        print(f"event=radius-auth result=wrong-router user={username} source={source_ip}", flush=True)
        return build_response(ACCESS_REJECT, packet["id"], packet["auth"], secret, b"", True)
    limit = int(checks.get("Simultaneous-Use") or 1)
    names = set(candidates) | {stored}
    close_stale_sessions(cursor, names)
    rows = open_session_rows(cursor, names)
    if limit > 0 and len(rows) >= limit:
        kicked = rows[: len(rows) - limit + 1]
        kick_sessions(cursor, kicked)
        print(f"event=radius-auth result=kick user={username} kicked={len(kicked)}", flush=True)
    if open_sessions(cursor, names) >= limit:
        print(f"event=radius-auth result=busy user={username} source={source_ip}", flush=True)
        return build_response(ACCESS_REJECT, packet["id"], packet["auth"], secret, b"", True)
    try:
        ok, extra = verify_password(packet, secret, cleartext)
    except Exception as error:
        print(f"event=radius-auth result=error user={username} source={source_ip} error={error}", flush=True)
        return build_response(ACCESS_REJECT, packet["id"], packet["auth"], secret, b"", True)
    if not ok:
        print(f"event=radius-auth result=reject user={username} source={source_ip}", flush=True)
        return build_response(ACCESS_REJECT, packet["id"], packet["auth"], secret, b"", True)
    attrs = reply_attributes(cursor, stored, extra)
    print(f"event=radius-auth result=accept user={username} source={source_ip}", flush=True)
    return build_response(ACCESS_ACCEPT, packet["id"], packet["auth"], secret, attrs, True)


def accounting(cursor, packet, source_ip):
    secret = nas_secret(cursor, source_ip, packet)
    if not secret:
        print(f"event=radius-acct result=no-nas source={source_ip}", flush=True)
        return None
    # RFC 2866: the Accounting-Request authenticator is MD5(code + id + length
    # + 16 zeroes + attributes + secret). Verify it before trusting anything —
    # accounting writes session rows and spends vouchers, so unsigned packets
    # must not reach the database.
    raw = packet.get("raw")
    expected = hashlib.md5((raw or b"")[:4] + bytes(16) + (raw or b"")[20:] + secret.encode()).digest()
    if not raw or not hmac.compare_digest(expected, packet["auth"]):
        print(f"event=radius-acct result=bad-auth source={source_ip}", flush=True)
        return None
    attrs = packet["attrs"]
    status = attr_int(attrs, 40)
    session_id = attr_text(attrs, 44)
    username = attr_text(attrs, 1)
    calling = attr_text(attrs, 31)
    framed_raw = attrs.get(8)
    framed = socket.inet_ntoa(framed_raw[0]) if framed_raw and len(framed_raw[0]) == 4 else ""
    session_time = attr_int(attrs, 46)
    gigawords_in = attr_int(attrs, 52)
    gigawords_out = attr_int(attrs, 53)
    bytes_in = (gigawords_in << 32) + attr_int(attrs, 42)
    bytes_out = (gigawords_out << 32) + attr_int(attrs, 43)
    cause_code = attr_int(attrs, 49)
    cause = TERMINATE_CAUSES.get(cause_code, str(cause_code) if cause_code else "")
    nas_ip_raw = attrs.get(4)
    nas_ip = socket.inet_ntoa(nas_ip_raw[0]) if nas_ip_raw and len(nas_ip_raw[0]) == 4 else source_ip
    unique = hashlib.md5(f"{nas_ip}|{session_id}".encode()).hexdigest()
    if not session_id:
        return build_response(ACCOUNTING_RESPONSE, packet["id"], packet["auth"], secret, b"", True)
    if username and nas_ip:
        names = _username_roots(username)
        marks = ", ".join(["%s"] * len(names))
        cursor.execute(
            f"""
            UPDATE pppoe_subscribers s
            JOIN isp_mikrotik_devices d ON d.tunnel_ip = %s AND d.client_id = s.client_id
            SET s.router_id = d.id
            WHERE s.service = 'pppoe' AND s.pppoe_username IN ({marks}) AND (s.router_id <> d.id OR s.router_id IS NULL)
            """,
            [nas_ip, *names],
        )
    if status == STATUS_START:
        # Acct-Session-Id is a per-router counter that restarts on reboot, so
        # two routers routinely reuse the same id — always scope by NAS.
        cursor.execute(
            "UPDATE radacct SET acctstoptime = NOW() WHERE acctsessionid = %s AND nasipaddress = %s AND acctstoptime IS NULL",
            (session_id, nas_ip),
        )
        cursor.execute(
            """
            INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress,
                                 acctstarttime, acctupdatetime, callingstationid, framedipaddress)
            VALUES (%s, %s, %s, %s, NOW(), NOW(), %s, %s)
            """,
            (session_id, unique, username, nas_ip, calling, framed),
        )
    elif status in (STATUS_INTERIM, STATUS_STOP):
        stop = status == STATUS_STOP
        cursor.execute(
            """
            UPDATE radacct
            SET acctupdatetime = NOW(),
                acctsessiontime = %s,
                acctinputoctets = %s,
                acctoutputoctets = %s,
                framedipaddress = COALESCE(NULLIF(%s, ''), framedipaddress),
                acctstoptime = IF(%s, NOW(), acctstoptime),
                acctterminatecause = IF(%s, %s, acctterminatecause)
            WHERE acctsessionid = %s AND nasipaddress = %s AND acctstoptime IS NULL
            """,
            (session_time, bytes_in, bytes_out, framed, stop, stop, cause[:32], session_id, nas_ip),
        )
        if cursor.rowcount == 0:
            cursor.execute(
                """
                INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress,
                                     acctstarttime, acctupdatetime, acctstoptime, acctsessiontime,
                                     acctinputoctets, acctoutputoctets, callingstationid,
                                     acctterminatecause, framedipaddress)
                VALUES (%s, %s, %s, %s,
                        DATE_SUB(NOW(), INTERVAL %s SECOND), NOW(), IF(%s, NOW(), NULL), %s,
                        %s, %s, %s, %s, %s)
                """,
                (
                    session_id,
                    unique,
                    username,
                    nas_ip,
                    session_time,
                    stop,
                    session_time,
                    bytes_in,
                    bytes_out,
                    calling,
                    cause[:32] if stop else None,
                    framed,
                ),
            )
    if username:
        # A live accounting session means the subscriber is surfing — spend
        # any single-use voucher their last payment issued.
        try:
            pppoe_store.mark_vouchers_used(cursor, pppoe_service.username_aliases(username))
            pppoe_store.mark_hotspot_vouchers_used(cursor, pppoe_service.username_aliases(username))
        except Exception:
            pass
    return build_response(ACCOUNTING_RESPONSE, packet["id"], packet["auth"], secret, b"", True)


def _listener(port, handler, connect, stop):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.bind(("0.0.0.0", port))
    except OSError as error:
        STATUS[port] = "bind-failed"
        print(f"event=radius port={port} bind-failed error={error}", flush=True)
        sock.close()
        return
    sock.settimeout(1.0)
    db = connect()
    try:
        db.ping(reconnect=False)
    except Exception:
        pass
    STATUS[port] = "listening"
    print(f"event=radius port={port} status=listening", flush=True)
    while not stop.is_set():
        try:
            data, source = sock.recvfrom(4096)
        except socket.timeout:
            continue
        except OSError:
            break
        packet = parse_packet(data)
        if packet is None:
            continue
        try:
            with db.cursor() as cursor:
                response = handler(cursor, packet, source[0])
        except (pymysql.err.OperationalError, pymysql.err.InterfaceError):
            # Dead connection — hand it back for disposal and take a fresh one
            # from the pool rather than reconnecting in place.
            try:
                db.close()
                db = connect()
                with db.cursor() as cursor:
                    response = handler(cursor, packet, source[0])
            except Exception as error:
                print(f"event=radius port={port} error={error}", flush=True)
                continue
        except Exception as error:
            print(f"event=radius port={port} error={error}", flush=True)
            continue
        if response:
            try:
                sock.sendto(response, source)
            except OSError:
                pass
    db.close()
    sock.close()


def _allow_posix_port(port, proto="udp"):
    """Linux counterpart of _allow_port: ufw's default deny would silently drop
    tunnel traffic. Scopes the rule to the tunnel interface when it exists."""
    import shutil
    import subprocess

    if not shutil.which("ufw"):
        return
    import wg_host

    if wg_host.tunnel_running():
        cmd = [
            "ufw", "allow", "in", "on", wg_host.TUNNEL_NAME,
            "to", "any", "port", str(port), "proto", proto,
        ]
    else:
        cmd = ["ufw", "allow", f"{port}/{proto}"]
    try:
        subprocess.run(cmd, capture_output=True, timeout=15, check=False)
    except (OSError, subprocess.TimeoutExpired):
        pass


def _allow_port(port):
    import subprocess

    if os.name != "nt":
        _allow_posix_port(port)
        return
    try:
        subprocess.run(
            [
                "netsh", "advfirewall", "firewall", "add", "rule",
                f'name="ISP CENTRIC RADIUS {port}"',
                "dir=in", "action=allow", "protocol=UDP", f"localport={port}",
            ],
            capture_output=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass


def start(connect):
    """Bind the RADIUS auth and accounting listeners on this host."""
    stop = threading.Event()
    _allow_port(AUTH_PORT)
    _allow_port(ACCT_PORT)
    for port, handler in ((AUTH_PORT, authenticate), (ACCT_PORT, accounting)):
        thread = threading.Thread(
            target=_listener,
            args=(port, handler, connect, stop),
            name=f"radius-{port}",
            daemon=True,
        )
        thread.start()
    return stop
