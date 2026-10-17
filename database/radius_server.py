"""Minimal RADIUS authentication and accounting server.

Listens on UDP 1812 and 1813 so MikroTik routers can authenticate PPPoE
subscribers against the radcheck/radreply/radusergroup/radgroupreply
tables this application maintains. No external FreeRADIUS install is
needed; the NAS shared secret comes from the `nas` table, keyed by the
router address that sends the packet.
"""

import hashlib
import hmac
import socket
import struct
import threading

AUTH_PORT = 1812
ACCT_PORT = 1813
STATUS = {}

VENDOR_MICROSOFT = 311
VENDOR_MIKROTIK = 14988

ACCESS_REQUEST = 1
ACCESS_ACCEPT = 2
ACCESS_REJECT = 3
ACCOUNTING_REQUEST = 4
ACCOUNTING_RESPONSE = 5

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
    from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES
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
    return {"code": code, "id": ident, "auth": authenticator, "attrs": attributes, "vendor": vendor}


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
    if ms_chap1 is not None and len(ms_chap1) >= 49:
        server_challenge = vendor_attr(packet["vendor"], VENDOR_MICROSOFT, MS_CHAP_CHALLENGE) or packet["auth"]
        nt_response = ms_chap1[24:48]
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


def nas_secret(cursor, source_ip, packet):
    names = [source_ip]
    nas_ip = packet["attrs"].get(4)
    if nas_ip and len(nas_ip[0]) == 4:
        names.append(socket.inet_ntoa(nas_ip[0]))
    ident = attr_text(packet["attrs"], 32)
    if ident:
        names.append(ident)
    placeholders = ", ".join(["%s"] * len(names))
    cursor.execute(f"SELECT secret FROM nas WHERE nasname IN ({placeholders}) LIMIT 1", names)
    row = cursor.fetchone()
    return row["secret"] if row else None


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


def open_sessions(cursor, username):
    cursor.execute(
        "SELECT COUNT(*) AS open_count FROM radacct WHERE username = %s AND acctstoptime IS NULL",
        (username,),
    )
    return int(cursor.fetchone()["open_count"])


def authenticate(cursor, packet, source_ip):
    secret = nas_secret(cursor, source_ip, packet)
    if not secret:
        print(f"event=radius-auth result=no-nas source={source_ip}", flush=True)
        return None
    username = attr_text(packet["attrs"], 1)
    if not username:
        return build_response(ACCESS_REJECT, packet["id"], packet["auth"], secret, b"", 80 in packet["attrs"])
    cursor.execute("SELECT attribute, value FROM radcheck WHERE username = %s", (username,))
    checks = {row["attribute"]: row["value"] for row in cursor.fetchall()}
    cleartext = checks.get("Cleartext-Password")
    if checks.get("Auth-Type") == "Reject" or not cleartext:
        return build_response(ACCESS_REJECT, packet["id"], packet["auth"], secret, b"", 80 in packet["attrs"])
    limit = int(checks.get("Simultaneous-Use") or 1)
    if open_sessions(cursor, username) >= limit:
        return build_response(ACCESS_REJECT, packet["id"], packet["auth"], secret, b"", 80 in packet["attrs"])
    ok, extra = verify_password(packet, secret, cleartext)
    if not ok:
        print(f"event=radius-auth result=reject user={username} source={source_ip}", flush=True)
        return build_response(ACCESS_REJECT, packet["id"], packet["auth"], secret, b"", 80 in packet["attrs"])
    attrs = reply_attributes(cursor, username, extra)
    print(f"event=radius-auth result=accept user={username} source={source_ip}", flush=True)
    return build_response(ACCESS_ACCEPT, packet["id"], packet["auth"], secret, attrs, 80 in packet["attrs"])


def accounting(cursor, packet, source_ip):
    secret = nas_secret(cursor, source_ip, packet)
    if not secret:
        print(f"event=radius-acct result=no-nas source={source_ip}", flush=True)
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
        return build_response(ACCOUNTING_RESPONSE, packet["id"], packet["auth"], secret, b"", 80 in attrs)
    if status == STATUS_START:
        cursor.execute(
            "UPDATE radacct SET acctstoptime = NOW() WHERE acctsessionid = %s AND acctstoptime IS NULL",
            (session_id,),
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
            WHERE acctsessionid = %s AND acctstoptime IS NULL
            """,
            (session_time, bytes_in, bytes_out, framed, stop, stop, cause[:32], session_id),
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
    return build_response(ACCOUNTING_RESPONSE, packet["id"], packet["auth"], secret, b"", 80 in attrs)


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
        db.ping(reconnect=True)
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
            db.ping(reconnect=True)
            with db.cursor() as cursor:
                response = handler(cursor, packet, source[0])
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


def _allow_port(port):
    import subprocess

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
