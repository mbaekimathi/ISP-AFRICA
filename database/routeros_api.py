"""Read-only RouterOS API client and sealed API passwords.

The management user created by the WinBox script is isp-centric.
Passwords are sealed before they are stored. Live reads use the tunnel
address and never change router configuration.
"""

import base64
import hashlib
import hmac
import os
import re
import secrets
import socket
from datetime import datetime, timedelta

API_USER = "isp-centric"
API_PORT = 8728
DEV_PASSWORD = "Itsispcentric@001"


def sample_router(name):
    """Development stand-in used when no router is connected."""
    return {
        "reachable": True,
        "sample": True,
        "identity": name or "Sample router",
        "board": "hAP ax3",
        "version": "7.16.2",
        "uptime": "3d14h22m",
        "cpuLoad": "6",
        "cpu": "ARM64",
        "architecture": "arm64",
        "platform": "MikroTik",
        "freeMemory": "820 MB",
        "totalMemory": "1024 MB",
        "interfaces": [
            {"name": "ether1", "type": "ether", "running": True, "disabled": False, "comment": "WAN", "rxByte": "482334720", "txByte": "91234560"},
            {"name": "bridge", "type": "bridge", "running": True, "disabled": False, "comment": "LAN", "rxByte": "120448000", "txByte": "88442210"},
            {"name": "ether2", "type": "ether", "running": True, "disabled": False, "comment": "PPPoE", "rxByte": "2201100", "txByte": "884400"},
            {"name": "ether3", "type": "ether", "running": True, "disabled": False, "comment": "Hotspot", "rxByte": "5512000", "txByte": "2211000"},
            {"name": "isp-centric", "type": "wg", "running": False, "disabled": False, "comment": "Management tunnel", "rxByte": "0", "txByte": "0"},
        ],
        "interfaceCount": 5,
        "hotspotActive": 12,
        "pppoeActive": 48,
        "health": sample_health(),
    }


def duration_label(started, ended, now=None):
    now = now or datetime.now()
    finish = ended or now
    seconds = max(0, int((finish - started).total_seconds()))
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    days, hours = divmod(hours, 24)
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    if minutes:
        return f"{minutes}m" if seconds == 0 else f"{minutes}m {seconds}s"
    return f"{seconds}s"


def health_event(subject, reason, started, ended, now=None):
    now = now or datetime.now()
    return {
        "subject": subject,
        "reason": reason,
        "startedAt": started.isoformat(sep=" ", timespec="seconds"),
        "endedAt": ended.isoformat(sep=" ", timespec="seconds") if ended else None,
        "duration": duration_label(started, ended, now),
        "open": ended is None,
    }


TREND_SCALES = ("live", "hours", "days", "weeks", "month", "year")


def trend_since(scale, now):
    if scale == "days":
        return now - timedelta(days=7)
    if scale == "hours":
        return now - timedelta(hours=3)
    if scale == "weeks":
        return now - timedelta(weeks=8)
    if scale == "month":
        return now - timedelta(days=30)
    if scale == "year":
        return now - timedelta(days=370)
    return now - timedelta(hours=1)


def trend_buckets(scale, now):
    now = now.replace(microsecond=0)
    if scale == "days":
        start = now.replace(hour=0, minute=0, second=0) - timedelta(days=6)
        return [(start + timedelta(days=i), start + timedelta(days=i + 1), (start + timedelta(days=i)).strftime("%a")) for i in range(7)]
    if scale == "weeks":
        start = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0) - timedelta(weeks=7)
        return [(start + timedelta(weeks=i), start + timedelta(weeks=i + 1), (start + timedelta(weeks=i)).strftime("%d %b")) for i in range(8)]
    if scale == "month":
        start = now.replace(hour=0, minute=0, second=0) - timedelta(days=29)
        return [(start + timedelta(days=i), start + timedelta(days=i + 1), (start + timedelta(days=i)).strftime("%d")) for i in range(30)]
    if scale == "year":
        month = now.replace(day=1, hour=0, minute=0, second=0)
        for _ in range(11):
            month = (month - timedelta(days=1)).replace(day=1)
        buckets = []
        for _ in range(12):
            nxt = month.replace(year=month.year + 1, month=1) if month.month == 12 else month.replace(month=month.month + 1)
            buckets.append((month, nxt, month.strftime("%b")))
            month = nxt
        return buckets
    if scale == "hours":
        end = now.replace(second=0)
        end = end.replace(minute=(end.minute // 15) * 15) + timedelta(minutes=15)
        return [
            (end - timedelta(minutes=15 * (12 - i)), end - timedelta(minutes=15 * (11 - i)), (end - timedelta(minutes=15 * (12 - i))).strftime("%H:%M"))
            for i in range(12)
        ]
    end = now.replace(second=0)
    end = end.replace(minute=(end.minute // 5) * 5) + timedelta(minutes=5)
    return [
        (end - timedelta(minutes=5 * (12 - i)), end - timedelta(minutes=5 * (11 - i)), (end - timedelta(minutes=5 * (12 - i))).strftime("%H:%M"))
        for i in range(12)
    ]


def trend_series(spans, now=None, scale="live"):
    now = now or datetime.now().replace(microsecond=0)
    if scale not in TREND_SCALES:
        scale = "live"
    points = []
    for start, end, label in trend_buckets(scale, now):
        minutes = 0
        count = 0
        window_end = min(end, now)
        for started, ended in spans:
            finish = ended or now
            overlap_start = max(started, start)
            overlap_end = min(finish, window_end)
            if overlap_end > overlap_start:
                seconds = int((overlap_end - overlap_start).total_seconds())
                minutes += seconds // 60 if seconds >= 60 else 1
            if start <= started < end:
                count += 1
        points.append({"label": label, "date": start.isoformat(sep=" ", timespec="minutes"), "minutes": minutes, "drops": count})
    return points


def sample_setup(name):
    """Development stand-in used when no router is connected."""
    return {
        "reachable": True,
        "sample": True,
        "identity": name or "Sample router",
        "dns": "1.1.1.1,8.8.8.8",
        "ntpEnabled": True,
        "services": [
            {"name": "winbox", "port": "8291", "disabled": False, "address": ""},
            {"name": "api", "port": "8728", "disabled": False, "address": ""},
            {"name": "ssh", "port": "22", "disabled": True, "address": ""},
            {"name": "www", "port": "80", "disabled": True, "address": ""},
        ],
        "users": [
            {"name": "admin", "group": "full", "disabled": False},
            {"name": API_USER, "group": "isp-centric-api", "disabled": False},
        ],
        "wifi": [
            {
                "name": "wifi1",
                "ssid": "Sample",
                "password": "",
                "passwordVisible": False,
                "disabled": False,
                "security": "default",
                "kind": "wifi",
            },
            {
                "name": "wifi2",
                "ssid": "Guest",
                "password": "",
                "passwordVisible": False,
                "disabled": True,
                "security": "guest",
                "kind": "wifi",
            },
        ],
    }


def sample_health(now=None):
    now = now or datetime.now().replace(microsecond=0)
    spans = [
        (now - timedelta(days=6, hours=2), now - timedelta(days=6, hours=2) + timedelta(minutes=22)),
        (now - timedelta(days=4, hours=3), now - timedelta(days=4, hours=3) + timedelta(minutes=41)),
        (now - timedelta(days=3, hours=1), now - timedelta(days=3, hours=1) + timedelta(minutes=9)),
        (now - timedelta(days=2, hours=6), now - timedelta(days=2, hours=6) + timedelta(minutes=12)),
        (now - timedelta(hours=26, minutes=18), now - timedelta(hours=26)),
        (now - timedelta(hours=5, minutes=6), now - timedelta(hours=5)),
        (now - timedelta(minutes=50), now - timedelta(minutes=46)),
        (now - timedelta(minutes=42), None),
        (now - timedelta(days=40), now - timedelta(days=40) + timedelta(minutes=35)),
        (now - timedelta(days=200), now - timedelta(days=200) + timedelta(minutes=28)),
    ]
    reasons = [
        ("ether1", "No carrier on the WAN port"),
        ("ether1", "No carrier on the WAN port"),
        ("ether3", "Hotspot interface stopped running"),
        ("ether2", "PPPoE interface stopped running"),
        ("ether1", "No carrier on the WAN port"),
        ("ether2", "PPPoE interface stopped running"),
        ("ether1", "No carrier on the WAN port"),
        ("isp-centric", "Management tunnel did not answer"),
        ("ether1", "No carrier on the WAN port"),
        ("ether2", "PPPoE interface stopped running"),
    ]
    drops = [health_event(subject, reason, started, ended, now) for (subject, reason), (started, ended) in zip(reasons, spans)]
    drops.sort(key=lambda item: item["startedAt"], reverse=True)
    trends = {scale: trend_series(spans, now, scale) for scale in TREND_SCALES}
    return {"drops": drops[:8], "trend": trends["live"], "trends": trends}


class RouterError(Exception):
    pass


def script_is_allowed(source):
    """Only the selection scripts from this app may be sent to a router."""
    text = str(source or "")
    if len(text) < 8 or len(text) > 20000 or "ISP CENTRIC" not in text:
        return False
    lowered = text.lower()
    blocked = (
        "reboot",
        "reset-configuration",
        "/system backup",
        "/system/backup",
        "/user",
        "/tool",
        "/file",
        "/export",
        "/import",
        "password=",
        "/system script",
        "/system/script",
        "/ip firewall nat",
        "/ip route",
    )
    return not any(item in lowered for item in blocked)


def run_script(host, password, source, timeout=8, port=API_PORT, opener=None):
    """Run one checked selection. The temporary script is removed afterward."""
    if not script_is_allowed(source):
        raise RouterError("That choice cannot be applied.")
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    name = "isp-centric-apply"
    script_id = ""
    reader = None
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        existing = talk(sock, reader, ["/system/script/print"])
        for row in existing:
            if row.get("name") == name and _row_id(row):
                talk(sock, reader, ["/system/script/remove", f"=.id={_row_id(row)}"])
        added = talk(sock, reader, ["/system/script/add", f"=name={name}", f"=source={source}"])
        script_id = next((row.get("ret") for row in added if row.get("ret")), "")
        if not script_id:
            listed = talk(sock, reader, ["/system/script/print"])
            script_id = next((_row_id(row) for row in listed if row.get("name") == name), "")
        if not script_id:
            raise RouterError("The router did not accept this choice.")
        talk(sock, reader, ["/system/script/run", f"=.id={script_id}"])
    finally:
        if script_id and reader is not None:
            try:
                talk(sock, reader, ["/system/script/remove", f"=.id={script_id}"])
            except Exception:
                pass
        sock.close()
    return {"applied": True, "message": "The router matches this choice."}


def seal_key():
    secret = os.environ.get("ISP_ROUTER_SECRET") or os.environ.get("ISP_ACCOUNT_CODE_SECRET") or "isp-centric-router"
    return hashlib.sha256(secret.encode()).digest()


def seal_password(password):
    if not isinstance(password, str) or not password:
        raise RouterError("Enter the API password from the WinBox script.")
    if password == DEV_PASSWORD and os.environ.get("ISP_ENV") == "production":
        raise RouterError("That example password cannot be used in production. Run the onboarding script to set a unique one.")
    nonce = os.urandom(16)
    raw = password.encode()
    body = bytes(left ^ right for left, right in zip(raw, keystream(seal_key(), nonce, len(raw))))
    mac = hmac.new(seal_key(), nonce + body, hashlib.sha256).digest()
    return base64.b64encode(nonce + mac + body).decode()


def open_password(sealed):
    try:
        packed = base64.b64decode(sealed.encode(), validate=True)
        nonce, mac, body = packed[:16], packed[16:48], packed[48:]
        expected = hmac.new(seal_key(), nonce + body, hashlib.sha256).digest()
        if not hmac.compare_digest(mac, expected):
            raise RouterError("saved")
        return bytes(left ^ right for left, right in zip(body, keystream(seal_key(), nonce, len(body)))).decode()
    except RouterError:
        raise RouterError("The saved API password could not be read. Enter it again.") from None
    except Exception as error:
        raise RouterError("The saved API password could not be read. Enter it again.") from error


def keystream(key, nonce, size):
    stream = b""
    counter = 0
    while len(stream) < size:
        stream += hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
        counter += 1
    return stream[:size]


def encode_length(length):
    if length < 0x80:
        return bytes([length])
    if length < 0x4000:
        return (length | 0x8000).to_bytes(2, "big")
    if length < 0x200000:
        return (length | 0xC00000).to_bytes(3, "big")
    if length < 0x10000000:
        return (length | 0xE0000000).to_bytes(4, "big")
    return b"\xf0" + length.to_bytes(4, "big")


def encode_sentence(words):
    payload = b""
    for word in words:
        raw = word.encode()
        payload += encode_length(len(raw)) + raw
    return payload + b"\x00"


class ByteReader:
    def __init__(self, sock):
        self.sock = sock
        self.buffer = b""

    def read(self, size):
        while len(self.buffer) < size:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RouterError("The router closed the API connection.")
            self.buffer += chunk
        data, self.buffer = self.buffer[:size], self.buffer[size:]
        return data

    def read_length(self):
        first = self.read(1)[0]
        if first < 0x80:
            return first
        if first < 0xC0:
            return ((first & 0x3F) << 8) + self.read(1)[0]
        if first < 0xE0:
            rest = self.read(2)
            return ((first & 0x1F) << 16) + (rest[0] << 8) + rest[1]
        if first < 0xF0:
            rest = self.read(3)
            return ((first & 0x0F) << 24) + (rest[0] << 16) + (rest[1] << 8) + rest[2]
        rest = self.read(4)
        return int.from_bytes(rest, "big")

    def read_sentence(self):
        words = []
        while True:
            length = self.read_length()
            if length == 0:
                return words
            words.append(self.read(length).decode(errors="replace"))


def attributes(words):
    values = {}
    for word in words:
        if word.startswith("="):
            key, _, value = word[1:].partition("=")
            values[key] = value
    return values


def talk(sock, reader, words):
    sock.sendall(encode_sentence(words))
    rows = []
    trap = None
    while True:
        sentence = reader.read_sentence()
        if not sentence:
            continue
        kind = sentence[0]
        if kind == "!re":
            rows.append(attributes(sentence[1:]))
        elif kind == "!trap":
            trap = attributes(sentence[1:]).get("message") or "The router refused that read."
        elif kind == "!empty":
            continue
        elif kind == "!done":
            if trap:
                raise RouterError(trap)
            done = attributes(sentence[1:])
            if done:
                rows.append(done)
            return rows
        elif kind == "!fatal":
            raise RouterError("The router closed the API session.")
        else:
            raise RouterError("The router sent a reply this service could not read.")


def optional_count(sock, reader, command):
    try:
        return len(talk(sock, reader, [command]))
    except RouterError:
        return None


def optional_rows(sock, reader, command):
    try:
        return talk(sock, reader, [command])
    except RouterError:
        return []


def memory_label(value):
    try:
        amount = int(value)
    except (TypeError, ValueError):
        return None
    mb = amount / (1024 * 1024)
    if abs(mb - round(mb)) < 0.05:
        return f"{round(mb):.0f} MB"
    return f"{mb:.1f} MB"


def interface_outage(item):
    """A down bridge port with nothing plugged in is not an outage."""
    if not isinstance(item, dict) or item.get("disabled") or item.get("running"):
        return None
    if item.get("slave") or item.get("type") == "loopback":
        return None
    name = item.get("name") or "Interface"
    return f"{name} link down"


ROLE_LABELS = {
    "wan": "WAN",
    "lan": "LAN",
    "hotspot": "Hotspot",
    "pppoe": "PPPoE",
    "static": "Static",
    "dhcp": "DHCP",
}


def label_port_roles(interfaces, plan):
    if not isinstance(plan, dict):
        return interfaces
    for item in interfaces or []:
        if item.get("comment"):
            continue
        uses = plan.get(item.get("name")) or []
        if not isinstance(uses, list):
            continue
        label = ", ".join(ROLE_LABELS[use] for use in uses if use in ROLE_LABELS)
        if label:
            item["comment"] = label
    return interfaces


def read_router(host, password, timeout=4, port=API_PORT, opener=None):
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        identity = talk(sock, reader, ["/system/identity/print"])
        resource = talk(sock, reader, ["/system/resource/print"])
        interfaces = talk(sock, reader, ["/interface/print"])
        hotspot = optional_count(sock, reader, "/ip/hotspot/active/print")
        pppoe = optional_count(sock, reader, "/ppp/active/print")
    finally:
        sock.close()
    info = resource[0] if resource else {}
    names = identity[0] if identity else {}
    running = []
    for row in interfaces:
        running.append(
            {
                "name": row.get("name") or "",
                "type": row.get("type") or "",
                "running": row.get("running") == "true",
                "disabled": row.get("disabled") == "true",
                "comment": row.get("comment") or "",
                "slave": row.get("slave") == "true",
                "rxByte": row.get("rx-byte") or "0",
                "txByte": row.get("tx-byte") or "0",
            }
        )
    return {
        "reachable": True,
        "identity": names.get("name") or "",
        "board": info.get("board-name") or "",
        "version": info.get("version") or "",
        "uptime": info.get("uptime") or "",
        "cpuLoad": info.get("cpu-load") or "",
        "cpu": info.get("cpu") or "",
        "architecture": info.get("architecture-name") or "",
        "platform": info.get("platform") or "",
        "freeMemory": memory_label(info.get("free-memory")),
        "totalMemory": memory_label(info.get("total-memory")),
        "interfaces": running[:40],
        "interfaceCount": len(running),
        "hotspotActive": hotspot,
        "pppoeActive": pppoe,
    }


def subscriber_rates(host, password, username, timeout=4, port=API_PORT, opener=None):
    """Instantaneous rx/tx rates for the subscriber's dynamic <pppoe-username> interface."""
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        rows = talk(sock, reader, ["/interface/monitor-traffic", f"=interface=<pppoe-{username}>", "=once="])
    finally:
        sock.close()
    row = rows[0] if rows else {}

    def rate(key):
        try:
            return int(float(row.get(key) or 0))
        except (TypeError, ValueError):
            return 0

    return {"rxBps": rate("rx-bits-per-second"), "txBps": rate("tx-bits-per-second")}


def norm_mac(value):
    return "".join(ch for ch in (value or "") if ch.isalnum()).upper()


def uptime_seconds(value):
    """RouterOS uptime strings like '1w2d3h4m5s' or '18m29s' → seconds."""
    scale = {"w": 604800, "d": 86400, "h": 3600, "m": 60, "s": 1}
    return sum(int(amount) * scale[unit] for amount, unit in re.findall(r"(\d+)([wdhms])", value or ""))


def byte_count(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def live_sessions(host, password, username, timeout=4, port=API_PORT, opener=None):
    """Live PPPoE sessions for a subscriber, read straight from the router.

    Returns one entry per dialed-in device: {mac, ip, uptime, seconds,
    bytesIn, bytesOut}. Raises RouterError when the router can't be read.
    """
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        servers = talk(sock, reader, ["/interface/pppoe-server/print"])
        actives = [row for row in talk(sock, reader, ["/ppp/active/print"]) if row.get("name") == username]
        counters = {row.get("name"): row for row in talk(sock, reader, ["/interface/print"])}
    finally:
        sock.close()

    sessions = []
    for server in servers:
        if server.get("user") != username or server.get("dynamic") != "true":
            continue
        mac = server.get("remote-address") or ""
        active = next((row for row in actives if norm_mac(row.get("caller-id")) == norm_mac(mac)), {})
        iface = counters.get(server.get("name")) or {}
        uptime = server.get("uptime") or active.get("uptime") or ""
        sessions.append(
            {
                "mac": mac or active.get("caller-id") or "",
                "ip": active.get("address") or "",
                "uptime": uptime,
                "seconds": uptime_seconds(uptime),
                "bytesIn": byte_count(iface.get("rx-byte")),
                "bytesOut": byte_count(iface.get("tx-byte")),
            }
        )
    if not sessions:
        for active in actives:
            iface = counters.get(f"<pppoe-{username}>") or {}
            uptime = active.get("uptime") or ""
            sessions.append(
                {
                    "mac": active.get("caller-id") or "",
                    "ip": active.get("address") or "",
                    "uptime": uptime,
                    "seconds": uptime_seconds(uptime),
                    "bytesIn": byte_count(iface.get("rx-byte")),
                    "bytesOut": byte_count(iface.get("tx-byte")),
                }
            )
    return sessions


def lan_gadgets(host, password, interface="", timeout=4, port=API_PORT, opener=None):
    """End devices the router can see on its LAN.

    Sources: ARP, DHCP leases, bridge hosts, and hotspot hosts/actives.
    When interface is set (the subscriber's access VLAN or port) only
    gadgets learned on that interface are kept — they sit behind that
    subscriber's router. A router doing its own NAT hides its LAN, so
    only bridged devices ever appear here.
    """
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        arp = optional_rows(sock, reader, "/ip/arp/print")
        leases = optional_rows(sock, reader, "/ip/dhcp-server/lease/print")
        bridge_hosts = optional_rows(sock, reader, "/interface/bridge/host/print")
        hotspot_hosts = optional_rows(sock, reader, "/ip/hotspot/host/print")
        hotspot_active = optional_rows(sock, reader, "/ip/hotspot/active/print")
    finally:
        sock.close()

    scoped = set()
    if interface:
        for row in arp:
            if row.get("interface") == interface:
                scoped.add(norm_mac(row.get("mac-address")))
        for row in bridge_hosts:
            if row.get("on-interface") == interface:
                scoped.add(norm_mac(row.get("mac-address")))
        scoped.discard("")

    def allowed(mac):
        return bool(norm_mac(mac)) and (not interface or norm_mac(mac) in scoped)

    gadgets = {}

    def entry(mac):
        key = norm_mac(mac)
        if not key:
            return None
        return gadgets.setdefault(
            key,
            {
                "mac": mac,
                "ip": "",
                "name": "",
                "interface": "",
                "online": False,
                "authorized": False,
                "uptime": "",
                "seconds": 0,
                "bytesIn": 0,
                "bytesOut": 0,
                "lastSeen": "",
                "via": "lan",
            },
        )

    for row in bridge_hosts:
        if not allowed(row.get("mac-address")):
            continue
        item = entry(row.get("mac-address"))
        if item:
            item["interface"] = row.get("on-interface") or item["interface"]
            item["online"] = True
    for row in arp:
        if not allowed(row.get("mac-address")):
            continue
        item = entry(row.get("mac-address"))
        if item:
            item["ip"] = row.get("address") or item["ip"]
            item["interface"] = row.get("interface") or item["interface"]
            if row.get("complete") == "true" and row.get("invalid") != "true":
                item["online"] = True
    for row in leases:
        if not allowed(row.get("mac-address")):
            continue
        item = entry(row.get("mac-address"))
        if item:
            item["ip"] = row.get("address") or item["ip"]
            item["name"] = row.get("host-name") or item["name"]
            item["lastSeen"] = row.get("last-seen") or item["lastSeen"]
            if row.get("status") == "bound" and row.get("disabled") != "true":
                item["online"] = True
            item["via"] = "dhcp"
    for row in hotspot_hosts:
        if not allowed(row.get("mac-address")):
            continue
        item = entry(row.get("mac-address"))
        if item:
            item["ip"] = row.get("to-address") or row.get("address") or item["ip"]
            item["online"] = True
            item["authorized"] = item["authorized"] or row.get("authorized") == "true"
            uptime = row.get("uptime") or ""
            item["uptime"] = item["uptime"] or uptime
            item["seconds"] = max(item["seconds"], uptime_seconds(uptime))
            item["bytesIn"] += byte_count(row.get("bytes-in"))
            item["bytesOut"] += byte_count(row.get("bytes-out"))
            item["via"] = "hotspot"
    for row in hotspot_active:
        if not allowed(row.get("mac-address")):
            continue
        item = entry(row.get("mac-address"))
        if item:
            item["ip"] = row.get("address") or item["ip"]
            item["name"] = row.get("user") or item["name"]
            item["online"] = True
            item["authorized"] = True
            uptime = row.get("uptime") or ""
            item["uptime"] = uptime or item["uptime"]
            item["seconds"] = max(item["seconds"], uptime_seconds(uptime))
            item["bytesIn"] += byte_count(row.get("bytes-in"))
            item["bytesOut"] += byte_count(row.get("bytes-out"))
            item["via"] = "hotspot"
    return sorted(gadgets.values(), key=lambda item: (not item["online"], item["name"] or item["mac"]))[:40]


def disabled_flag(row):
    return row.get("disabled") == "true"


def wifi_radios(wifi_rows, wifi_security, wireless_rows, profiles):
    phrases = {}
    for row in wifi_security:
        phrases[row.get("name") or ""] = row.get("passphrase") or ""
    radios = []
    for row in wifi_rows:
        name = row.get("name") or ""
        if not name:
            continue
        security = row.get("security") or row.get("configuration.security") or ""
        password = phrases.get(security) or ""
        radios.append(
            {
                "name": name,
                "ssid": row.get("configuration.ssid") or row.get("ssid") or "",
                "password": password,
                "passwordVisible": bool(password),
                "disabled": disabled_flag(row),
                "security": security,
                "kind": "wifi",
            }
        )
    keys = {}
    for row in profiles:
        keys[row.get("name") or ""] = row.get("wpa2-pre-shared-key") or row.get("wpa-pre-shared-key") or ""
    for row in wireless_rows:
        name = row.get("name") or ""
        if not name:
            continue
        security = row.get("security-profile") or ""
        password = keys.get(security) or ""
        radios.append(
            {
                "name": name,
                "ssid": row.get("ssid") or "",
                "password": password,
                "passwordVisible": bool(password),
                "disabled": disabled_flag(row),
                "security": security,
                "kind": "wireless",
            }
        )
    return radios[:20]


def read_setup(host, password, timeout=4, port=API_PORT, opener=None):
    """Read identity, DNS, services, users, and WiFi. This does not change the router."""
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        identity = talk(sock, reader, ["/system/identity/print"])
        dns = talk(sock, reader, ["/ip/dns/print"])
        services = optional_rows(sock, reader, "/ip/service/print")
        users = optional_rows(sock, reader, "/user/print")
        wifi_rows = optional_rows(sock, reader, "/interface/wifi/print")
        wifi_security = optional_rows(sock, reader, "/interface/wifi/security/print")
        wireless_rows = optional_rows(sock, reader, "/interface/wireless/print")
        profiles = optional_rows(sock, reader, "/interface/wireless/security-profiles/print")
        ntp = optional_rows(sock, reader, "/system/ntp/client/print")
    finally:
        sock.close()
    names = identity[0] if identity else {}
    dns_row = dns[0] if dns else {}
    ntp_row = ntp[0] if ntp else {}
    return {
        "reachable": True,
        "identity": names.get("name") or "",
        "dns": dns_row.get("servers") or "",
        "ntpEnabled": ntp_row.get("enabled") == "true" if ntp else None,
        "services": [
            {
                "name": row.get("name") or "",
                "port": row.get("port") or "",
                "disabled": disabled_flag(row),
                "address": row.get("address") or "",
            }
            for row in services
            if row.get("name")
        ][:12],
        "users": [
            {
                "name": row.get("name") or "",
                "group": row.get("group") or "",
                "disabled": disabled_flag(row),
            }
            for row in users
            if row.get("name")
        ][:20],
        "wifi": wifi_radios(wifi_rows, wifi_security, wireless_rows, profiles),
    }


def _row_id(row):
    return row.get(".id") or ""


def _find_interface(rows, interface):
    return [row for row in rows if row.get("interface") == interface or row.get("out-interface") == interface]


def ping_reaches(rows):
    for row in rows or []:
        try:
            if int(row.get("received") or 0) > 0:
                return True
        except (TypeError, ValueError):
            continue
    return False


def classify_uplink(row, ping_rows):
    """Link down is unreachable. Link up without a reply is unhealthy."""
    if not row:
        return "unknown"
    disabled = row.get("disabled") in {True, "true"}
    running = row.get("running") in {True, "true"}
    if disabled or not running:
        return "unreachable"
    if ping_rows is None:
        return "unknown"
    return "healthy" if ping_reaches(ping_rows) else "unhealthy"


def default_route_ok(routes, active_name):
    """A distance-1 default route must exist on the router for the active uplink."""
    preferred = []
    for row in routes or []:
        if (row.get("dst-address") or "") not in {"0.0.0.0/0", ""}:
            continue
        if str(row.get("distance") or "1") != "1":
            continue
        if row.get("active") == "false":
            continue
        gateway = row.get("gateway") or ""
        immediate = row.get("immediate-gw") or ""
        if not gateway and not immediate:
            continue
        preferred.append(row)
    if not preferred or not active_name:
        return False
    marked = []
    tied = []
    for row in preferred:
        blob = f"{row.get('gateway') or ''} {row.get('immediate-gw') or ''}"
        if "%" in blob:
            marked.append(row)
            if f"%{active_name}" in blob:
                tied.append(row)
    if marked:
        return bool(tied)
    return True


def probe_wan(host, password, names, timeout=4, port=API_PORT, opener=None):
    """Check link state and one internet ping through each named uplink."""
    wanted = []
    for name in names:
        text = str(name or "").strip()
        if text and text not in wanted:
            wanted.append(text)
    wanted = wanted[:4]
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    health = {name: "unknown" for name in wanted}
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        interfaces = {row.get("name"): row for row in talk(sock, reader, ["/interface/print"])}
        for name in wanted:
            row = interfaces.get(name)
            if not row or row.get("disabled") in {True, "true"} or row.get("running") not in {True, "true"}:
                health[name] = classify_uplink(row, None if not row else [])
                if not row:
                    health[name] = "unknown"
                continue
            try:
                ping_rows = talk(sock, reader, ["/ping", "=address=1.1.1.1", "=count=1", f"=interface={name}"])
            except RouterError:
                health[name] = "unknown"
                continue
            health[name] = classify_uplink(row, ping_rows)
    finally:
        sock.close()
    return health


PPPOE_POOL = "pppoe-pool"
PPPOE_PROFILE = "pppoe-pool-profile"
PPPOE_SERVICE = "pppoe"
PPPOE_LOCAL = "10.10.0.1"
PPPOE_RANGE = "10.10.0.2-10.10.0.254"
PPPOE_ADDRESS = "10.10.0.1/24"
PPPOE_NETWORK = "10.10.0.0/24"
PPPOE_ALLOW = "isp-centric-pppoe-allow"
PPPOE_ALLOW_BACK = "isp-centric-pppoe-allow-back"
PPPOE_PORTAL_SUS_UP = "isp-centric-pppoe-portal-sus-up"
PPPOE_PORTAL_SUS_DOWN = "isp-centric-pppoe-portal-sus-down"
PPPOE_PORTAL_EXP_UP = "isp-centric-pppoe-portal-exp-up"
PPPOE_PORTAL_EXP_DOWN = "isp-centric-pppoe-portal-exp-down"
PPPOE_SUSPEND = "isp-centric-pppoe-suspended"
PPPOE_SUSPEND_BACK = "isp-centric-pppoe-suspended-back"
PPPOE_EXPIRED_DROP = "isp-centric-pppoe-expired"
PPPOE_EXPIRED_DROP_BACK = "isp-centric-pppoe-expired-back"
PPPOE_DROP_PPP = "isp-centric-pppoe-drop-ppp"
PPPOE_DROP_PPP_BACK = "isp-centric-pppoe-drop-ppp-back"
PPPOE_DROP = "isp-centric-pppoe-drop"
PPPOE_DROP_PPP_V6 = "isp-centric-pppoe-drop-ppp-v6"
PPPOE_DROP_V6 = "isp-centric-pppoe-drop-v6"
PPPOE_SUBSCRIBED = "pppoe-subscribed"
PPPOE_SUSPENDED = "pppoe-suspended"
PPPOE_EXPIRED = "pppoe-expired"
PPPOE_COA = "isp-centric-coa"
PPPOE_DNS_UDP = "isp-centric-pppoe-dns-udp"
PPPOE_DNS_TCP = "isp-centric-pppoe-dns-tcp"
PPPOE_PORTAL_NAT_SUS = "isp-centric-pppoe-portal-sus"
PPPOE_PORTAL_NAT_EXP = "isp-centric-pppoe-portal-exp"
PPPOE_FILTERS = (
    PPPOE_DNS_UDP,
    PPPOE_DNS_TCP,
    PPPOE_ALLOW,
    PPPOE_ALLOW_BACK,
    PPPOE_PORTAL_SUS_UP,
    PPPOE_PORTAL_SUS_DOWN,
    PPPOE_PORTAL_EXP_UP,
    PPPOE_PORTAL_EXP_DOWN,
    PPPOE_SUSPEND,
    PPPOE_SUSPEND_BACK,
    PPPOE_EXPIRED_DROP,
    PPPOE_EXPIRED_DROP_BACK,
    PPPOE_DROP_PPP,
    PPPOE_DROP_PPP_BACK,
    PPPOE_DROP,
)
PPPOE_V6_FILTERS = (PPPOE_DROP_PPP_V6, PPPOE_DROP_V6)
PPPOE_NATS = (PPPOE_PORTAL_NAT_SUS, PPPOE_PORTAL_NAT_EXP)


def _portal_target(radius):
    host = str((radius or {}).get("address") or os.environ.get("ISP_PORTAL_IP") or "10.88.0.1")
    port = int(os.environ.get("ISP_PORTAL_PORT") or 8790)
    return host, port
IFACE_NAME = r"^[A-Za-z0-9_.:-]{1,32}$"


def router_change_message(error):
    message = str(error)
    if "not enough permissions" in message.lower():
        return "This router user can read settings but cannot change them."
    if message == "The management tunnel did not answer.":
        return "The router did not answer, so enforcement was not changed."
    return message


def _safe_iface(name):
    return bool(re.fullmatch(IFACE_NAME, name or ""))


def _physical_port(row):
    name = row.get("name") or ""
    if name == "isp-centric" or not _safe_iface(name):
        return False
    if row.get("type") == "ether":
        return True
    lowered = name.lower()
    return lowered.startswith(("ether", "sfp", "combo", "qsfp"))


def _pppoe_port(interfaces, servers, preferred="", avoid=None):
    if preferred and _safe_iface(preferred):
        return preferred
    avoid = set(avoid or ())
    for row in servers:
        name = row.get("interface") or ""
        if _safe_iface(name) and name not in avoid:
            return name
    for row in interfaces:
        if _physical_port(row) and "pppoe" in (row.get("comment") or "").lower() and (row.get("name") or "") not in avoid:
            return row.get("name") or ""
    for row in interfaces:
        if _physical_port(row) and (row.get("name") or "") not in avoid:
            return row.get("name") or ""
    for row in interfaces:
        if _physical_port(row):
            return row.get("name") or ""
    return ""


def _named(rows, name):
    return [row for row in rows if row.get("name") == name and _row_id(row)]


def _radius_secret_ok(secret):
    return isinstance(secret, str) and 8 <= len(secret) <= 64 and all(character.isalnum() or character in "-_" for character in secret)


def _configure_subscriber_radius(sock, reader, radius):
    if not radius:
        return
    address = str(radius.get("address") or "")
    secret = str(radius.get("secret") or "")
    source = str(radius.get("source") or "")
    if not re.fullmatch(r"(?:\d{1,3}\.){3}\d{1,3}", address) or not _radius_secret_ok(secret):
        raise RouterError("RADIUS for this router is not ready, so enforcement was not changed.")
    fields = [f"=address={address}", f"=secret={secret}", "=service=ppp", "=timeout=3s"]
    if re.fullmatch(r"(?:\d{1,3}\.){3}\d{1,3}", source):
        fields.append(f"=src-address={source}")
    rows = talk(sock, reader, ["/radius/print"])
    matched = [
        row
        for row in rows
        if _row_id(row) and (row.get("address") == address or "ppp" in (row.get("service") or "").split(","))
    ]
    if matched:
        for row in matched:
            talk(sock, reader, ["/radius/set", f"=.id={_row_id(row)}", *fields])
    else:
        talk(sock, reader, ["/radius/add", *fields])
    talk(sock, reader, ["/radius/incoming/set", "=accept=yes"])
    filters = talk(sock, reader, ["/ip/firewall/filter/print"])
    if not any(row.get("comment") == PPPOE_COA and _row_id(row) for row in filters):
        _add_placed(
            sock,
            reader,
            [
                "/ip/firewall/filter/add",
                "=chain=input",
                "=action=accept",
                "=protocol=udp",
                "=dst-port=3799",
                "=in-interface=isp-centric",
                f"=comment={PPPOE_COA}",
                "=place-before=0",
            ],
        )
    talk(sock, reader, ["/ppp/aaa/set", "=use-radius=yes", "=accounting=yes", "=interim-update=5m"])


def _drop_open_sessions(sock, reader):
    for row in talk(sock, reader, ["/ppp/active/print"]):
        if _row_id(row):
            talk(sock, reader, ["/ppp/active/remove", f"=.id={_row_id(row)}"])


def _move_filter(sock, reader, rule_id, destination):
    """Best-effort ordering. Rules are added at the top already, and RouterOS refuses to move builtin entries."""
    try:
        talk(sock, reader, ["/ip/firewall/filter/move", f"=numbers={rule_id}", f"=destination={destination}"])
    except RouterError:
        pass


def _add_placed(sock, reader, words):
    """Add a rule near the top, falling back to a plain add when placement before a builtin entry is refused."""
    try:
        talk(sock, reader, words)
    except RouterError:
        talk(sock, reader, [word for word in words if not word.startswith("=place-before=")])


def _enable_pppoe(sock, reader, iface, servers, radius=None, shared=False):
    pools = talk(sock, reader, ["/ip/pool/print"])
    if not _named(pools, PPPOE_POOL):
        talk(sock, reader, ["/ip/pool/add", f"=name={PPPOE_POOL}", f"=ranges={PPPOE_RANGE}"])
    profiles = talk(sock, reader, ["/ppp/profile/print"])
    matched_profiles = _named(profiles, PPPOE_PROFILE)
    if matched_profiles:
        for row in matched_profiles:
            talk(
                sock,
                reader,
                [
                    "/ppp/profile/set",
                    f"=.id={_row_id(row)}",
                    f"=local-address={PPPOE_LOCAL}",
                    f"=dns-server={PPPOE_LOCAL}",
                    "=change-tcp-mss=yes",
                ],
            )
    else:
        talk(
            sock,
            reader,
            [
                "/ppp/profile/add",
                f"=name={PPPOE_PROFILE}",
                f"=local-address={PPPOE_LOCAL}",
                f"=remote-address={PPPOE_POOL}",
                f"=dns-server={PPPOE_LOCAL}",
                "=only-one=yes",
                "=change-tcp-mss=yes",
            ],
        )
    talk(sock, reader, ["/ip/dns/set", "=allow-remote-requests=yes"])
    matched = [row for row in servers if row.get("service-name") == PPPOE_SERVICE and _row_id(row)]
    if matched:
        for row in matched:
            talk(
                sock,
                reader,
                [
                    "/interface/pppoe-server/server/set",
                    f"=.id={_row_id(row)}",
                    "=disabled=no",
                    f"=interface={iface}",
                    f"=default-profile={PPPOE_PROFILE}",
                ],
            )
    else:
        talk(
            sock,
            reader,
            [
                "/interface/pppoe-server/server/add",
                f"=service-name={PPPOE_SERVICE}",
                f"=interface={iface}",
                f"=default-profile={PPPOE_PROFILE}",
                "=disabled=no",
            ],
        )
    # Configure RADIUS before any firewall change: if the secret is rejected we
    # abort here, while subscribers can still dial — not after drop rules are
    # already live and the API rolls the enforcement flag back.
    _configure_subscriber_radius(sock, reader, radius)
    for row in talk(sock, reader, ["/ip/firewall/filter/print"]):
        if row.get("comment") in PPPOE_FILTERS and _row_id(row):
            talk(sock, reader, ["/ip/firewall/filter/remove", f"=.id={_row_id(row)}"])
    for protocol, comment in (("udp", PPPOE_DNS_UDP), ("tcp", PPPOE_DNS_TCP)):
        _add_placed(
            sock,
            reader,
            [
                "/ip/firewall/filter/add",
                "=chain=input",
                "=action=accept",
                f"=protocol={protocol}",
                "=dst-port=53",
                "=in-interface=all-ppp",
                f"=comment={comment}",
                "=place-before=0",
            ],
        )
    _portal_nat(sock, reader)
    portal_ip, portal_port = _portal_target(radius)
    rules = []
    if not shared:
        rules.append(
            ["/ip/firewall/filter/add", "=chain=forward", "=action=drop", f"=in-interface={iface}", f"=comment={PPPOE_DROP}", "=place-before=0"]
        )
    rules += [
        ["/ip/firewall/filter/add", "=chain=forward", "=action=drop", "=out-interface=all-ppp", f"=comment={PPPOE_DROP_PPP_BACK}", "=place-before=0"],
        ["/ip/firewall/filter/add", "=chain=forward", "=action=drop", "=in-interface=all-ppp", f"=comment={PPPOE_DROP_PPP}", "=place-before=0"],
        ["/ip/firewall/filter/add", "=chain=forward", "=action=drop", f"=dst-address-list={PPPOE_EXPIRED}", f"=comment={PPPOE_EXPIRED_DROP_BACK}", "=place-before=0"],
        ["/ip/firewall/filter/add", "=chain=forward", "=action=drop", f"=src-address-list={PPPOE_EXPIRED}", f"=comment={PPPOE_EXPIRED_DROP}", "=place-before=0"],
        ["/ip/firewall/filter/add", "=chain=forward", "=action=drop", f"=dst-address-list={PPPOE_SUSPENDED}", f"=comment={PPPOE_SUSPEND_BACK}", "=place-before=0"],
        ["/ip/firewall/filter/add", "=chain=forward", "=action=drop", f"=src-address-list={PPPOE_SUSPENDED}", f"=comment={PPPOE_SUSPEND}", "=place-before=0"],
        ["/ip/firewall/filter/add", "=chain=forward", "=action=accept", f"=dst-address-list={PPPOE_EXPIRED}", f"=src-address={portal_ip}", "=out-interface=all-ppp", f"=comment={PPPOE_PORTAL_EXP_DOWN}", "=place-before=0"],
        ["/ip/firewall/filter/add", "=chain=forward", "=action=accept", f"=src-address-list={PPPOE_EXPIRED}", f"=dst-address={portal_ip}", "=in-interface=all-ppp", f"=comment={PPPOE_PORTAL_EXP_UP}", "=place-before=0"],
        ["/ip/firewall/filter/add", "=chain=forward", "=action=accept", f"=dst-address-list={PPPOE_SUSPENDED}", f"=src-address={portal_ip}", "=out-interface=all-ppp", f"=comment={PPPOE_PORTAL_SUS_DOWN}", "=place-before=0"],
        ["/ip/firewall/filter/add", "=chain=forward", "=action=accept", f"=src-address-list={PPPOE_SUSPENDED}", f"=dst-address={portal_ip}", "=in-interface=all-ppp", f"=comment={PPPOE_PORTAL_SUS_UP}", "=place-before=0"],
        ["/ip/firewall/filter/add", "=chain=forward", "=action=accept", f"=dst-address-list={PPPOE_SUBSCRIBED}", "=out-interface=all-ppp", f"=comment={PPPOE_ALLOW_BACK}", "=place-before=0"],
        ["/ip/firewall/filter/add", "=chain=forward", "=action=accept", f"=src-address-list={PPPOE_SUBSCRIBED}", "=in-interface=all-ppp", f"=comment={PPPOE_ALLOW}", "=place-before=0"],
    ]
    for rule in rules:
        _add_placed(sock, reader, rule)
    rows = talk(sock, reader, ["/ip/firewall/filter/print"])
    ours = {row.get("comment"): _row_id(row) for row in rows if row.get("comment") in PPPOE_FILTERS}
    anchor = next(
        (
            _row_id(row)
            for row in rows
            if row.get("chain") == "forward"
            and row.get("comment") not in PPPOE_FILTERS
            and row.get("dynamic") != "true"
            and row.get("builtin") != "true"
            and _row_id(row)
        ),
        "",
    )
    order = [
        PPPOE_ALLOW,
        PPPOE_ALLOW_BACK,
        PPPOE_PORTAL_SUS_UP,
        PPPOE_PORTAL_SUS_DOWN,
        PPPOE_PORTAL_EXP_UP,
        PPPOE_PORTAL_EXP_DOWN,
        PPPOE_SUSPEND,
        PPPOE_SUSPEND_BACK,
        PPPOE_EXPIRED_DROP,
        PPPOE_EXPIRED_DROP_BACK,
        PPPOE_DROP_PPP,
        PPPOE_DROP_PPP_BACK,
    ]
    if not shared:
        order.append(PPPOE_DROP)
    if anchor:
        for comment in order:
            if ours.get(comment):
                _move_filter(sock, reader, ours[comment], anchor)
    else:
        for index in range(len(order) - 2, -1, -1):
            if ours.get(order[index]) and ours.get(order[index + 1]):
                _move_filter(sock, reader, ours[order[index]], ours[order[index + 1]])
    prefix = PPPOE_LOCAL.rsplit(".", 1)[0] + "."
    try:
        connections = talk(sock, reader, ["/ip/firewall/connection/print"])
    except RouterError:
        connections = []
    for row in connections:
        touched = any(
            (row.get(key) or "").startswith(prefix)
            for key in ("src-address", "dst-address", "reply-src-address", "reply-dst-address")
        )
        if touched and _row_id(row):
            try:
                talk(sock, reader, ["/ip/firewall/connection/remove", f"=.id={_row_id(row)}"])
            except RouterError:
                pass
    try:
        for row in talk(sock, reader, ["/ipv6/firewall/filter/print"]):
            if row.get("comment") in PPPOE_V6_FILTERS and _row_id(row):
                talk(sock, reader, ["/ipv6/firewall/filter/remove", f"=.id={_row_id(row)}"])
        v6_targets = [("all-ppp", PPPOE_DROP_PPP_V6)] if shared else [("all-ppp", PPPOE_DROP_PPP_V6), (iface, PPPOE_DROP_V6)]
        for target, comment in v6_targets:
            talk(
                sock,
                reader,
                [
                    "/ipv6/firewall/filter/add",
                    "=chain=forward",
                    "=action=drop",
                    f"=in-interface={target}",
                    f"=comment={comment}",
                ],
            )
    except RouterError:
        pass
    nats = talk(sock, reader, ["/ip/firewall/nat/print"])
    for comment, address_list in ((PPPOE_PORTAL_NAT_SUS, PPPOE_SUSPENDED), (PPPOE_PORTAL_NAT_EXP, PPPOE_EXPIRED)):
        matched = [row for row in nats if row.get("comment") == comment and _row_id(row)]
        if matched:
            for row in matched:
                talk(
                    sock,
                    reader,
                    [
                        "/ip/firewall/nat/set",
                        f"=.id={_row_id(row)}",
                        f"=to-addresses={portal_ip}",
                        f"=to-ports={portal_port}",
                    ],
                )
        else:
            talk(
                sock,
                reader,
                [
                    "/ip/firewall/nat/add",
                    "=chain=dstnat",
                    "=action=dst-nat",
                    "=protocol=tcp",
                    "=dst-port=80",
                    f"=src-address-list={address_list}",
                    f"=to-addresses={portal_ip}",
                    f"=to-ports={portal_port}",
                    f"=comment={comment}",
                ],
            )
    if not shared:
        for row in talk(sock, reader, ["/ip/dhcp-server/print"]):
            if row.get("interface") == iface and row.get("disabled") != "true" and _row_id(row):
                talk(sock, reader, ["/ip/dhcp-server/set", f"=.id={_row_id(row)}", "=disabled=yes"])
    for row in talk(sock, reader, ["/ip/hotspot/print"]):
        ours = row.get("name") == DHCP_PORTAL_NAME or (row.get("interface") == iface and row.get("profile") == DHCP_PORTAL_PROFILE)
        if ours and row.get("disabled") != "true" and _row_id(row):
            talk(sock, reader, ["/ip/hotspot/set", f"=.id={_row_id(row)}", "=disabled=yes"])
    _drop_open_sessions(sock, reader)


def _disable_pppoe(sock, reader, iface, shared=False):
    for row in talk(sock, reader, ["/interface/pppoe-server/server/print"]):
        if row.get("service-name") == PPPOE_SERVICE and row.get("disabled") != "true" and _row_id(row):
            talk(sock, reader, ["/interface/pppoe-server/server/set", f"=.id={_row_id(row)}", "=disabled=yes"])
    for row in talk(sock, reader, ["/ip/firewall/filter/print"]):
        if row.get("comment") in PPPOE_FILTERS and _row_id(row):
            talk(sock, reader, ["/ip/firewall/filter/remove", f"=.id={_row_id(row)}"])
    try:
        for row in talk(sock, reader, ["/ipv6/firewall/filter/print"]):
            if row.get("comment") in PPPOE_V6_FILTERS and _row_id(row):
                talk(sock, reader, ["/ipv6/firewall/filter/remove", f"=.id={_row_id(row)}"])
    except RouterError:
        pass
    for row in talk(sock, reader, ["/ip/firewall/nat/print"]):
        if row.get("comment") in PPPOE_NATS and _row_id(row):
            talk(sock, reader, ["/ip/firewall/nat/remove", f"=.id={_row_id(row)}"])
    if shared:
        return
    addresses = talk(sock, reader, ["/ip/address/print"])
    if not any(row.get("interface") == iface and row.get("address") == PPPOE_ADDRESS for row in addresses):
        talk(
            sock,
            reader,
            [
                "/ip/address/add",
                f"=address={PPPOE_ADDRESS}",
                f"=interface={iface}",
                "=comment=isp-centric-dhcp",
            ],
        )
    pools = talk(sock, reader, ["/ip/pool/print"])
    if not _named(pools, PPPOE_POOL):
        talk(sock, reader, ["/ip/pool/add", f"=name={PPPOE_POOL}", f"=ranges={PPPOE_RANGE}"])
    dhcp = talk(sock, reader, ["/ip/dhcp-server/print"])
    matched = _named(dhcp, PPPOE_POOL)
    if matched:
        for row in matched:
            if row.get("disabled") == "true":
                talk(sock, reader, ["/ip/dhcp-server/set", f"=.id={_row_id(row)}", "=disabled=no"])
    else:
        talk(
            sock,
            reader,
            [
                "/ip/dhcp-server/add",
                f"=name={PPPOE_POOL}",
                f"=interface={iface}",
                f"=address-pool={PPPOE_POOL}",
                "=disabled=no",
            ],
        )
    networks = talk(sock, reader, ["/ip/dhcp-server/network/print"])
    if not any(row.get("address") == PPPOE_NETWORK for row in networks):
        talk(
            sock,
            reader,
            [
                "/ip/dhcp-server/network/add",
                f"=address={PPPOE_NETWORK}",
                f"=gateway={PPPOE_LOCAL}",
                f"=dns-server={PPPOE_LOCAL}",
            ],
        )
    _hotspot_profile(sock, reader, DHCP_PORTAL_PROFILE, PPPOE_LOCAL, DHCP_PORTAL_DNS)
    _hotspot_server(sock, reader, DHCP_PORTAL_NAME, iface, PPPOE_POOL, DHCP_PORTAL_PROFILE)
    _captive_portal(sock, reader)


def _wan_ports(sock, reader):
    """Interfaces that carry upstream traffic: WAN-listed ports and dhcp-client ports."""
    avoid = set()
    lan = set()
    try:
        for row in talk(sock, reader, ["/interface/list/member/print"]):
            name = row.get("interface") or ""
            if row.get("list") == "WAN":
                avoid.add(name)
            elif row.get("list") == "LAN":
                lan.add(name)
    except RouterError:
        pass
    try:
        for row in talk(sock, reader, ["/ip/dhcp-client/print"]):
            name = row.get("interface") or ""
            if row.get("disabled") != "true":
                avoid.add(name)
    except RouterError:
        pass
    return avoid, lan


def apply_pppoe_enforcement(host, password, enforced, timeout=12, port=API_PORT, opener=None, radius=None, access=None):
    """Turn PPPoE enforcement on or off with direct API writes. This does not create a system script."""
    if not isinstance(enforced, bool):
        raise RouterError("Choose whether PPPoE enforcement is on or off.")
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        interfaces = talk(sock, reader, ["/interface/print"])
        servers = talk(sock, reader, ["/interface/pppoe-server/server/print"])
        avoid, lan = _wan_ports(sock, reader)
        iface = _pppoe_port(interfaces, servers, preferred=access or "", avoid=avoid)
        if not _safe_iface(iface):
            raise RouterError("This router has no port for PPPoE, so nothing was changed.")
        try:
            bridges = talk(sock, reader, ["/interface/bridge/port/print"])
        except RouterError:
            bridges = []
        iface = _bridge_target(bridges, iface)
        kinds = {row.get("name") or "": row.get("type") or "" for row in interfaces}
        shared = kinds.get(iface) == "bridge" or iface in lan
        if enforced:
            _enable_pppoe(sock, reader, iface, servers, radius, shared=shared)
        else:
            _disable_pppoe(sock, reader, iface, shared=shared)
    finally:
        sock.close()
    return {"applied": True, "message": "Updated on the router."}


PORT_ORDER = ("wan", "lan", "hotspot", "pppoe", "static", "dhcp")
PORT_LABELS = {
    "wan": "WAN",
    "lan": "LAN",
    "hotspot": "Hotspot",
    "pppoe": "PPPoE",
    "static": "Static IP",
    "dhcp": "DHCP",
}


def port_defaults(iface, use):
    digits = re.findall(r"\d+", iface)
    index = min(254, max(1, int(digits[0]) if digits else 1))
    offset = PORT_ORDER.index(use) + 1
    gateway = f"10.{index}.{offset}.1"
    slug = re.sub(r"[^A-Za-z0-9_-]", "", f"{use}-{iface}")[:20] or use
    return {
        "address": f"{gateway}/24",
        "pool": f"{slug}-pool"[:32],
        "local": gateway,
        "range": f"10.{index}.{offset}.2-10.{index}.{offset}.254",
        "service": slug,
        "dns": f"{slug}.local"[:64],
        "network": f"10.{index}.{offset}.0/24",
    }


def _bridge_target(rows, iface):
    for row in rows:
        bridge = row.get("bridge") or ""
        if row.get("interface") == iface and _safe_iface(bridge):
            return bridge
    return iface


def _missing_name(rows, name):
    return not any(row.get("name") == name for row in rows)


def _missing_address(rows, address):
    return not any(row.get("address") == address for row in rows)


def _configure_port(sock, reader, target, uses):
    if "wan" in uses:
        clients = talk(sock, reader, ["/ip/dhcp-client/print"])
        if not any(row.get("interface") == target for row in clients):
            talk(
                sock,
                reader,
                [
                    "/ip/dhcp-client/add",
                    f"=interface={target}",
                    "=add-default-route=yes",
                    "=use-peer-dns=yes",
                    "=disabled=no",
                    "=comment=isp-centric-wan",
                ],
            )
    hotspot = port_defaults(target, "hotspot") if "hotspot" in uses else None
    if "static" in uses or "lan" in uses:
        use = "lan" if "lan" in uses else "static"
        details = port_defaults(target, use)
        if not hotspot or details["address"] != hotspot["address"]:
            addresses = talk(sock, reader, ["/ip/address/print"])
            if _missing_address(addresses, details["address"]):
                comment = "isp-centric-lan" if use == "lan" else "isp-centric-static"
                talk(
                    sock,
                    reader,
                    ["/ip/address/add", f"=address={details['address']}", f"=interface={target}", f"=comment={comment}"],
                )
    if "dhcp" in uses:
        details = port_defaults(target, "dhcp")
        pools = talk(sock, reader, ["/ip/pool/print"])
        if _missing_name(pools, details["pool"]):
            talk(sock, reader, ["/ip/pool/add", f"=name={details['pool']}", f"=ranges={details['range']}"])
        addresses = talk(sock, reader, ["/ip/address/print"])
        if _missing_address(addresses, details["address"]):
            talk(
                sock,
                reader,
                ["/ip/address/add", f"=address={details['address']}", f"=interface={target}", "=comment=isp-centric-dhcp"],
            )
        servers = talk(sock, reader, ["/ip/dhcp-server/print"])
        if not any(row.get("interface") == target for row in servers):
            talk(
                sock,
                reader,
                [
                    "/ip/dhcp-server/add",
                    f"=name={details['pool']}",
                    f"=interface={target}",
                    f"=address-pool={details['pool']}",
                    "=disabled=no",
                ],
            )
        networks = talk(sock, reader, ["/ip/dhcp-server/network/print"])
        if _missing_address(networks, details["network"]):
            talk(
                sock,
                reader,
                [
                    "/ip/dhcp-server/network/add",
                    f"=address={details['network']}",
                    f"=gateway={details['local']}",
                    f"=dns-server={details['local']}",
                ],
            )
    if "pppoe" in uses:
        details = port_defaults(target, "pppoe")
        pools = talk(sock, reader, ["/ip/pool/print"])
        if _missing_name(pools, details["pool"]):
            talk(sock, reader, ["/ip/pool/add", f"=name={details['pool']}", f"=ranges={details['range']}"])
        if not hotspot or details["local"] != hotspot["local"]:
            addresses = talk(sock, reader, ["/ip/address/print"])
            if _missing_address(addresses, f"{details['local']}/32") and _missing_address(addresses, details["address"]):
                talk(
                    sock,
                    reader,
                    ["/ip/address/add", f"=address={details['local']}/32", f"=interface={target}", "=comment=isp-centric-pppoe"],
                )
        profile = f"{details['pool']}-profile"
        profiles = talk(sock, reader, ["/ppp/profile/print"])
        if _missing_name(profiles, profile):
            talk(
                sock,
                reader,
                [
                    "/ppp/profile/add",
                    f"=name={profile}",
                    f"=local-address={details['local']}",
                    f"=remote-address={details['pool']}",
                    "=only-one=yes",
                ],
            )
        servers = talk(sock, reader, ["/interface/pppoe-server/server/print"])
        if not any(row.get("service-name") == details["service"] for row in servers):
            talk(
                sock,
                reader,
                [
                    "/interface/pppoe-server/server/add",
                    f"=service-name={details['service']}",
                    f"=interface={target}",
                    f"=default-profile={profile}",
                    "=disabled=no",
                ],
            )
    if hotspot:
        pools = talk(sock, reader, ["/ip/pool/print"])
        if _missing_name(pools, hotspot["pool"]):
            talk(sock, reader, ["/ip/pool/add", f"=name={hotspot['pool']}", f"=ranges={hotspot['range']}"])
        addresses = talk(sock, reader, ["/ip/address/print"])
        if _missing_address(addresses, hotspot["address"]):
            talk(
                sock,
                reader,
                ["/ip/address/add", f"=address={hotspot['address']}", f"=interface={target}", "=comment=isp-centric-hotspot"],
            )
        profile = f"{hotspot['service']}-profile"
        _hotspot_profile(sock, reader, profile, hotspot["local"], hotspot["dns"])
        spots = talk(sock, reader, ["/ip/hotspot/print"])
        if not any(row.get("interface") == target for row in spots):
            _hotspot_server(sock, reader, hotspot["service"], target, hotspot["pool"], profile)
        servers = talk(sock, reader, ["/ip/dhcp-server/print"])
        if not any(row.get("interface") == target for row in servers):
            talk(
                sock,
                reader,
                [
                    "/ip/dhcp-server/add",
                    f"=name={hotspot['service']}-dhcp",
                    f"=interface={target}",
                    f"=address-pool={hotspot['pool']}",
                    "=disabled=no",
                ],
            )
        networks = talk(sock, reader, ["/ip/dhcp-server/network/print"])
        if _missing_address(networks, hotspot["network"]):
            talk(
                sock,
                reader,
                [
                    "/ip/dhcp-server/network/add",
                    f"=address={hotspot['network']}",
                    f"=gateway={hotspot['local']}",
                    f"=dns-server={hotspot['local']}",
                ],
            )
        _captive_portal(sock, reader)


def apply_port_uses(host, password, plan, timeout=12, port=API_PORT, opener=None):
    """Apply each port's selected use with generated addresses. This does not create a system script."""
    if not isinstance(plan, dict):
        raise RouterError("Choose what at least one port will do.")
    chosen = {}
    for iface, uses in plan.items():
        if not _safe_iface(str(iface)) or not isinstance(uses, list):
            raise RouterError("Choose a port that exists on this router.")
        cleaned = []
        for use in uses:
            if use not in PORT_ORDER or use in cleaned:
                raise RouterError("Choose what that port will do.")
            cleaned.append(use)
        if cleaned:
            chosen[str(iface)] = cleaned
    if not chosen:
        raise RouterError("Choose what at least one port will do.")
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        interfaces = talk(sock, reader, ["/interface/print"])
        known = {row.get("name"): row for row in interfaces if row.get("name")}
        bridges = talk(sock, reader, ["/interface/bridge/port/print"])
        for iface, uses in chosen.items():
            row = known.get(iface)
            if not row:
                raise RouterError("That interface was not found. No changes were made.")
            target = _bridge_target(bridges, iface)
            comment = ", ".join(PORT_LABELS[use] for use in PORT_ORDER if use in uses)
            if _row_id(row):
                talk(sock, reader, ["/interface/set", f"=.id={_row_id(row)}", f"=comment={comment}"])
            _configure_port(sock, reader, target, uses)
    finally:
        sock.close()
    return {"applied": True, "message": "Updated on the router."}


HOTSPOT_NAME = "hotspot"
HOTSPOT_ADDRESS = "10.5.50.1/24"
HOTSPOT_GATEWAY = "10.5.50.1"
HOTSPOT_NETWORK = "10.5.50.0/24"
HOTSPOT_POOL = "hotspot-pool"
HOTSPOT_RANGE = "10.5.50.2-10.5.50.254"
HOTSPOT_DNS = "hotspot.local"
HOTSPOT_BLOCK = "isp-centric-hotspot-block"
HOTSPOT_BLOCK_INPUT = "isp-centric-hotspot-block-input"
API_GROUP = "isp-centric-api"
NO_NAT = "isp-centric-no-nat"
PORTAL_NAT = "isp-centric-portal-nat"
PORTAL_NAT_SKIP = "isp-centric-portal-nat-skip"
PORTAL_WALLED = "isp-centric-portal-walled"
PORTAL_PAGES = "isp-portal"
PORTAL_PAGE_NAMES = ("login.html", "status.html", "error.html")
DHCP_PORTAL_NAME = "dhcp-portal"
DHCP_PORTAL_PROFILE = "dhcp-portal-profile"
DHCP_PORTAL_DNS = "portal.local"


def _hotspot_profile(sock, reader, name, address, dns):
    """The profile points the servlet at the pay portal pages."""
    profiles = talk(sock, reader, ["/ip/hotspot/profile/print"])
    matched = [row for row in profiles if row.get("name") == name and _row_id(row)]
    words = [
        f"=hotspot-address={address}",
        f"=dns-name={dns}",
        f"=html-directory={PORTAL_PAGES}",
        "=login-by=http-pap,http-chap,cookie",
    ]
    if matched:
        for row in matched:
            talk(sock, reader, ["/ip/hotspot/profile/set", f"=.id={_row_id(row)}"] + words)
    else:
        talk(sock, reader, ["/ip/hotspot/profile/add", f"=name={name}"] + words)


def _hotspot_server(sock, reader, name, iface, pool, profile):
    """Exactly one enabled hotspot server on the chosen interface.

    A server with our name sitting on another interface (e.g. an uplink port)
    is rebound here instead of merely re-enabled, and duplicates on the target
    interface are parked so two servers never fight over the same clients.
    """
    spots = talk(sock, reader, ["/ip/hotspot/print"])
    candidates = [
        row
        for row in spots
        if _row_id(row) and (row.get("name") == name or row.get("interface") == iface)
    ]
    keep = next((row for row in candidates if row.get("interface") == iface), None)
    if keep is None:
        keep = next((row for row in candidates if row.get("name") == name), None)
    words = [
        f"=interface={iface}",
        f"=profile={profile}",
        f"=address-pool={pool}",
        "=disabled=no",
    ]
    if keep is None:
        talk(sock, reader, ["/ip/hotspot/add", f"=name={name}", *words])
    else:
        talk(sock, reader, ["/ip/hotspot/set", f"=.id={_row_id(keep)}", *words])
    for row in candidates:
        if row is not keep and row.get("disabled") != "true":
            talk(sock, reader, ["/ip/hotspot/set", f"=.id={_row_id(row)}", "=disabled=yes"])


def _ensure_group_policy(sock, reader, wanted):
    groups = talk(sock, reader, ["/user/group/print"])
    matched = [row for row in groups if row.get("name") == API_GROUP and _row_id(row)]
    if not matched:
        return
    policy = {part for part in (matched[0].get("policy") or "").split(",") if part}
    if wanted <= policy:
        return
    talk(
        sock,
        reader,
        ["/user/group/set", f"=.id={_row_id(matched[0])}", f"=policy={','.join(sorted(policy | wanted))}"],
    )


def _portal_group(sock, reader):
    """The fetch tool needs the ftp policy to save the portal pages."""
    _ensure_group_policy(sock, reader, {"read", "write", "api", "test", "ftp"})


def reboot_router(host, password, timeout=6, port=API_PORT, opener=None):
    """Restart the router. RouterOS answers !done, then drops the API session as it reboots."""
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        try:
            _ensure_group_policy(sock, reader, {"reboot"})
        except RouterError:
            pass
        try:
            talk(sock, reader, ["/system/reboot"])
        except RouterError as error:
            message = str(error)
            if "closed" in message:
                return {"rebooting": True}
            if "not enough permissions" in message.lower():
                raise RouterError("The API user cannot restart this router. Grant the reboot policy to the isp-centric-api group.") from error
            raise
    finally:
        sock.close()
    return {"rebooting": True}


def _portal_nat(sock, reader):
    """Captive clients reach the portal through the tunnel.

    Traffic toward the portal is masqueraded to the router's tunnel address so
    it passes the server peer's allowed addresses, and the portal can tell which
    router the visitor came through. The walled garden entry lets unauthorized
    hotspot users fetch the pay page.
    """
    host, port = _portal_target(None)
    try:
        walled = talk(sock, reader, ["/ip/hotspot/walled-garden/ip/print"])
    except RouterError:
        walled = []
    if not any(row.get("dst-address") == host and _row_id(row) for row in walled):
        try:
            talk(
                sock,
                reader,
                [
                    "/ip/hotspot/walled-garden/ip/add",
                    f"=dst-address={host}",
                    "=action=accept",
                    f"=comment={PORTAL_WALLED}",
                ],
            )
        except RouterError:
            pass
    nats = talk(sock, reader, ["/ip/firewall/nat/print"])
    for row in nats:
        if row.get("comment") in {PORTAL_NAT, PORTAL_NAT_SKIP} and _row_id(row):
            talk(sock, reader, ["/ip/firewall/nat/remove", f"=.id={_row_id(row)}"])
    anchor = next((_row_id(row) for row in nats if row.get("comment") == NO_NAT and _row_id(row)), "0")
    _add_placed(
        sock,
        reader,
        [
            "/ip/firewall/nat/add",
            "=chain=srcnat",
            "=action=masquerade",
            "=protocol=tcp",
            f"=dst-address={host}",
            f"=dst-port={port}",
            f"=comment={PORTAL_NAT}",
            f"=place-before={anchor}",
        ],
    )
    # Anchor the skips on the masquerade rule itself, not on NO_NAT: when that
    # onboarding-script rule is absent the fallback anchor "0" would land the
    # masquerade on top and hide blocked clients behind the tunnel address.
    nats = talk(sock, reader, ["/ip/firewall/nat/print"])
    anchor = next((_row_id(row) for row in nats if row.get("comment") == PORTAL_NAT and _row_id(row)), anchor)
    for address_list in (PPPOE_EXPIRED, PPPOE_SUSPENDED):
        _add_placed(
            sock,
            reader,
            [
                "/ip/firewall/nat/add",
                "=chain=srcnat",
                "=action=accept",
                "=protocol=tcp",
                f"=dst-address={host}",
                f"=dst-port={port}",
                f"=src-address-list={address_list}",
                f"=comment={PORTAL_NAT_SKIP}",
                f"=place-before={anchor}",
            ],
        )


def _portal_pages(sock, reader):
    """Pull the pay pages from the portal so the servlet can redirect to them."""
    host, port = _portal_target(None)
    _portal_group(sock, reader)
    for name in PORTAL_PAGE_NAMES:
        try:
            talk(
                sock,
                reader,
                [
                    "/tool/fetch",
                    f"=url=http://{host}:{port}/hotspot-page/{name}",
                    f"=dst-path={PORTAL_PAGES}/{name}",
                    "=mode=http",
                ],
            )
        except RouterError:
            pass


def _captive_portal(sock, reader):
    _portal_nat(sock, reader)
    _portal_pages(sock, reader)


def _hotspot_port(interfaces, spots, avoid=None):
    """Pick the client-side interface for the hotspot. WAN-listed ports and
    dhcp-client ports are skipped so the hotspot can never capture the uplink."""
    avoid = set(avoid or ())
    for row in spots:
        name = row.get("interface") or ""
        if _safe_iface(name) and name not in avoid:
            return name
    for row in interfaces:
        if _physical_port(row) and "hotspot" in (row.get("comment") or "").lower() and (row.get("name") or "") not in avoid:
            return row.get("name") or ""
    for row in interfaces:
        if _physical_port(row) and (row.get("name") or "") not in avoid:
            return row.get("name") or ""
    return ""


def _harden_hotspot_gate(sock, reader):
    """Remove every path onto the internet that skips payment.

    None of these rows are created by the portal, so they survive every config
    push and quietly let unpaid devices surf. Every step is best-effort — a
    system row the router refuses to change (e.g. the built-in default-trial
    user) must not abort the whole enable.
    """

    def attempt(words):
        try:
            talk(sock, reader, words)
        except RouterError:
            pass

    for profile in talk(sock, reader, ["/ip/hotspot/profile/print"]):
        methods = [m for m in (profile.get("login-by") or "").split(",") if m]
        kept = [m for m in methods if m not in {"trial", "mac", "mac-auth"}]
        if kept != methods and _row_id(profile):
            attempt(
                ["/ip/hotspot/profile/set", f"=.id={_row_id(profile)}", f"=login-by={','.join(kept) or 'http-pap'}"]
            )
    # The RouterOS default 'admin' hotspot user ships with an empty password —
    # hitting /login?username=admin&password= logs anyone in for free.
    # Any other user row with an empty password is just as open. System users
    # like default-trial cannot be removed, so neuter them instead: disable
    # and set a random password.
    for user in talk(sock, reader, ["/ip/hotspot/user/print"]):
        if not user.get("password") and _row_id(user):
            try:
                talk(sock, reader, ["/ip/hotspot/user/remove", f"=.id={_row_id(user)}"])
            except RouterError:
                attempt(["/ip/hotspot/user/set", f"=.id={_row_id(user)}", "=disabled=yes"])
                attempt(["/ip/hotspot/user/set", f"=.id={_row_id(user)}", f"=password={secrets.token_hex(8)}"])
    # A bypassed ip-binding puts the client straight online without logging in.
    for binding in talk(sock, reader, ["/ip/hotspot/ip-binding/print"]):
        if (binding.get("type") or "regular") == "bypassed" and _row_id(binding):
            attempt(["/ip/hotspot/ip-binding/remove", f"=.id={_row_id(binding)}"])
    # A walled-garden entry that accepts the whole web is a free-for-all.
    for row in talk(sock, reader, ["/ip/hotspot/walled-garden/ip/print"]):
        dst = row.get("dst-address") or ""
        if row.get("action") == "accept" and dst in {"", "0.0.0.0/0", "::/0"} and _row_id(row):
            attempt(["/ip/hotspot/walled-garden/ip/remove", f"=.id={_row_id(row)}"])
    for row in talk(sock, reader, ["/ip/hotspot/walled-garden/print"]):
        opens_web = (
            row.get("action") == "accept"
            and not row.get("dst-host")
            and not row.get("dst-address")
            and str(row.get("dst-port") or "") in {"80", "443", "8080"}
        )
        if opens_web and _row_id(row):
            attempt(["/ip/hotspot/walled-garden/remove", f"=.id={_row_id(row)}"])


def _enable_hotspot(sock, reader, iface, spots):
    pools = talk(sock, reader, ["/ip/pool/print"])
    if _missing_name(pools, HOTSPOT_POOL):
        talk(sock, reader, ["/ip/pool/add", f"=name={HOTSPOT_POOL}", f"=ranges={HOTSPOT_RANGE}"])
    addresses = talk(sock, reader, ["/ip/address/print"])
    for row in addresses:
        if row.get("address") == HOTSPOT_ADDRESS and row.get("interface") != iface and _row_id(row):
            talk(sock, reader, ["/ip/address/remove", f"=.id={_row_id(row)}"])
            addresses.remove(row)
    if _missing_address(addresses, HOTSPOT_ADDRESS):
        talk(
            sock,
            reader,
            ["/ip/address/add", f"=address={HOTSPOT_ADDRESS}", f"=interface={iface}", "=comment=isp-centric-hotspot"],
        )
    profile = f"{HOTSPOT_NAME}-profile"
    _hotspot_profile(sock, reader, profile, HOTSPOT_GATEWAY, HOTSPOT_DNS)
    _hotspot_server(sock, reader, HOTSPOT_NAME, iface, HOTSPOT_POOL, profile)
    dhcp_name = f"{HOTSPOT_NAME}-dhcp"
    servers = talk(sock, reader, ["/ip/dhcp-server/print"])
    named = [row for row in servers if row.get("name") == dhcp_name and _row_id(row)]
    on_iface = [row for row in servers if row.get("interface") == iface and _row_id(row)]
    for row in named:
        if row.get("interface") == iface:
            if row.get("disabled") == "true":
                talk(sock, reader, ["/ip/dhcp-server/set", f"=.id={_row_id(row)}", "=disabled=no"])
        elif on_iface:
            if row.get("disabled") != "true":
                talk(sock, reader, ["/ip/dhcp-server/set", f"=.id={_row_id(row)}", "=disabled=yes"])
        else:
            talk(
                sock,
                reader,
                ["/ip/dhcp-server/set", f"=.id={_row_id(row)}", f"=interface={iface}", "=disabled=no"],
            )
            on_iface.append(row)
    if not on_iface:
        talk(
            sock,
            reader,
            [
                "/ip/dhcp-server/add",
                f"=name={dhcp_name}",
                f"=interface={iface}",
                f"=address-pool={HOTSPOT_POOL}",
                "=disabled=no",
            ],
        )
    networks = talk(sock, reader, ["/ip/dhcp-server/network/print"])
    if _missing_address(networks, HOTSPOT_NETWORK):
        talk(
            sock,
            reader,
            [
                "/ip/dhcp-server/network/add",
                f"=address={HOTSPOT_NETWORK}",
                f"=gateway={HOTSPOT_GATEWAY}",
                f"=dns-server={HOTSPOT_GATEWAY}",
            ],
        )
    for row in talk(sock, reader, ["/ip/firewall/filter/print"]):
        if row.get("comment") in {HOTSPOT_BLOCK, HOTSPOT_BLOCK_INPUT} and _row_id(row):
            talk(sock, reader, ["/ip/firewall/filter/remove", f"=.id={_row_id(row)}"])
    try:
        _harden_hotspot_gate(sock, reader)
    except RouterError:
        pass
    _captive_portal(sock, reader)


def _disable_hotspot(sock, reader, iface):
    for row in talk(sock, reader, ["/ip/hotspot/print"]):
        if _row_id(row) and row.get("disabled") != "true" and (row.get("interface") == iface or row.get("name") == HOTSPOT_NAME):
            talk(sock, reader, ["/ip/hotspot/set", f"=.id={_row_id(row)}", "=disabled=yes"])
    dhcp_name = f"{HOTSPOT_NAME}-dhcp"
    for row in talk(sock, reader, ["/ip/dhcp-server/print"]):
        if row.get("name") == dhcp_name and row.get("disabled") != "true" and _row_id(row):
            talk(sock, reader, ["/ip/dhcp-server/set", f"=.id={_row_id(row)}", "=disabled=yes"])
    filters = talk(sock, reader, ["/ip/firewall/filter/print"])
    if not any(row.get("comment") == HOTSPOT_BLOCK for row in filters):
        talk(
            sock,
            reader,
            [
                "/ip/firewall/filter/add",
                "=chain=forward",
                "=action=drop",
                f"=in-interface={iface}",
                f"=comment={HOTSPOT_BLOCK}",
            ],
        )
    if not any(row.get("comment") == HOTSPOT_BLOCK_INPUT for row in filters):
        talk(
            sock,
            reader,
            [
                "/ip/firewall/filter/add",
                "=chain=input",
                "=action=drop",
                f"=in-interface={iface}",
                f"=comment={HOTSPOT_BLOCK_INPUT}",
            ],
        )


def _device_mode_gate(sock, reader):
    """RouterOS 7.6+ can forbid features like hotspot and fetch in device-mode;
    lifting the flag needs a physical confirmation on the device. Request the
    change, then report which features are still blocked."""
    try:
        rows = talk(sock, reader, ["/system/device-mode/print"])
    except RouterError:
        return []
    blocked = [name for name in ("hotspot", "fetch") if rows and rows[0].get(name) == "no"]
    for name in blocked:
        try:
            talk(sock, reader, ["/system/device-mode/update", f"={name}=yes"])
        except RouterError:
            pass
    return blocked


def apply_hotspot_access(host, password, enabled, timeout=12, port=API_PORT, opener=None):
    """Turn hotspot access on or off with direct API writes. This does not create a system script."""
    if not isinstance(enabled, bool):
        raise RouterError("Choose whether the hotspot is on or off.")
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        interfaces = talk(sock, reader, ["/interface/print"])
        spots = talk(sock, reader, ["/ip/hotspot/print"])
        avoid, lan = _wan_ports(sock, reader)
        iface = _hotspot_port(interfaces, spots, avoid=avoid)
        if not _safe_iface(iface):
            raise RouterError("This router has no port for the hotspot, so nothing was changed.")
        try:
            bridges = talk(sock, reader, ["/interface/bridge/port/print"])
        except RouterError:
            bridges = []
        iface = _bridge_target(bridges, iface)
        if enabled:
            blocked = _device_mode_gate(sock, reader)
            if "hotspot" in blocked:
                raise RouterError(
                    "RouterOS device-mode does not allow hotspot. The change was queued — "
                    "press the router's reset button (or power-cycle it) to confirm, then push again."
                )
            _enable_hotspot(sock, reader, iface, spots)
        else:
            _disable_hotspot(sock, reader, iface)
        if enabled and "fetch" in blocked:
            return {
                "applied": True,
                "message": "Updated on the router. Press the reset button or power-cycle it once "
                           "to finish enabling 'fetch' — until then the pay pages cannot be downloaded.",
            }
    finally:
        sock.close()
    return {"applied": True, "message": "Updated on the router."}


def inspect_access(host, password, radius_address="", timeout=4, port=API_PORT, opener=None):
    """Read-only check used by the reconcile loop: are PPPoE enforcement and
    the hotspot actually live on the router right now?"""
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        # Past this point the tunnel is proven up — a failed /print (device-mode
        # gating, a mid-boot router, a transient API drop) means "feature absent",
        # not "router unreachable", so callers must not mark the tunnel down.
        def read(words):
            try:
                return talk(sock, reader, words)
            except RouterError:
                return []

        servers = read(["/interface/pppoe-server/server/print"])
        filters = read(["/ip/firewall/filter/print"])
        nats = read(["/ip/firewall/nat/print"])
        spots = read(["/ip/hotspot/print"])
        radius_rows = read(["/radius/print"])
        incoming = read(["/radius/incoming/print"])
        try:
            avoid, _lan = _wan_ports(sock, reader)
        except RouterError:
            avoid = set()
    finally:
        sock.close()
    comments = {row.get("comment") for row in filters}
    nat_redirects = {
        row.get("comment")
        for row in nats
        if row.get("chain") == "dstnat" and row.get("action") == "dst-nat" and row.get("disabled") != "true"
    }
    pppoe_server = any(
        row.get("service-name") == PPPOE_SERVICE and row.get("disabled") != "true" and _row_id(row)
        for row in servers
    )
    radius_ok = not radius_address or any(
        row.get("address") == radius_address and "ppp" in (row.get("service") or "").split(",")
        for row in radius_rows
    )
    # Without accept=yes on /radius/incoming the router refuses Disconnect-
    # Requests, so paused/expired subscribers keep their subscribed session
    # and are never moved into the portal address lists.
    incoming_ok = any(row.get("accept") == "yes" for row in incoming)
    pppoe = (
        pppoe_server
        and PPPOE_DROP_PPP in comments
        and PPPOE_ALLOW in comments
        and {PPPOE_PORTAL_NAT_SUS, PPPOE_PORTAL_NAT_EXP} <= nat_redirects
        and radius_ok
        and incoming_ok
    )
    hotspot = any(
        _row_id(row)
        and row.get("disabled") != "true"
        and (row.get("interface") or "") not in avoid
        for row in spots
    )
    return {"pppoe": pppoe, "hotspot": hotspot}


def authorize_hotspot_client(host, password, ip, mac, username, secret, profile, rate_limit, shared_users, uptime, timeout=12, port=API_PORT, opener=None):
    """Create a paid hotspot account on the router and log the waiting client in."""
    if not (_safe_iface(str(username)) and _safe_iface(str(secret))):
        raise RouterError("The hotspot account could not be prepared.")
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        try:
            _harden_hotspot_gate(sock, reader)
        except RouterError:
            pass
        profile_words = []
        if rate_limit:
            profile_words.append(f"=rate-limit={rate_limit}")
        if shared_users and int(shared_users) > 1:
            profile_words.append(f"=shared-users={int(shared_users)}")
        profiles = talk(sock, reader, ["/ip/hotspot/user/profile/print"])
        matched = [row for row in profiles if row.get("name") == profile and _row_id(row)]
        if matched:
            if profile_words:
                for row in matched:
                    talk(sock, reader, ["/ip/hotspot/user/profile/set", f"=.id={_row_id(row)}"] + profile_words)
        else:
            talk(sock, reader, ["/ip/hotspot/user/profile/add", f"=name={profile}"] + profile_words)
        user_words = [f"=password={secret}", f"=profile={profile}", f"=limit-uptime={uptime}"]
        users = talk(sock, reader, ["/ip/hotspot/user/print"])
        matched = [row for row in users if row.get("name") == username and _row_id(row)]
        if matched:
            for row in matched:
                talk(sock, reader, ["/ip/hotspot/user/set", f"=.id={_row_id(row)}"] + user_words)
        else:
            talk(sock, reader, ["/ip/hotspot/user/add", f"=name={username}"] + user_words)
        online = False
        if ip and mac:
            try:
                talk(
                    sock,
                    reader,
                    [
                        "/ip/hotspot/active/login",
                        f"=user={username}",
                        f"=password={secret}",
                        f"=ip={ip}",
                        f"=mac-address={mac}",
                    ],
                )
                online = True
            except RouterError:
                online = False
    finally:
        sock.close()
    return {"applied": True, "online": online}


def revoke_hotspot_client(host, password, usernames, timeout=12, port=API_PORT, opener=None):
    """Delete paid hotspot users and kick any live sessions they still hold."""
    names = {str(name) for name in usernames if str(name or "").strip()}
    if not names:
        raise RouterError("No hotspot usernames were provided.")
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    removed = 0
    dropped = 0
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        for row in talk(sock, reader, ["/ip/hotspot/active/print"]):
            if row.get("user") in names and _row_id(row):
                talk(sock, reader, ["/ip/hotspot/active/remove", f"=.id={_row_id(row)}"])
                dropped += 1
        for row in talk(sock, reader, ["/ip/hotspot/user/print"]):
            if row.get("name") in names and _row_id(row):
                talk(sock, reader, ["/ip/hotspot/user/remove", f"=.id={_row_id(row)}"])
                removed += 1
    finally:
        sock.close()
    return {"removed": removed, "dropped": dropped}


def _count(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def hotspot_active_sessions(host, password, usernames=None, macs=None, timeout=8, port=API_PORT, opener=None):
    """Live /ip/hotspot/active rows matching the guest's usernames or MACs."""
    wanted_users = {str(name) for name in (usernames or []) if str(name or "").strip()}
    wanted_macs = {str(mac).strip().upper() for mac in (macs or []) if str(mac or "").strip()}
    if not wanted_users and not wanted_macs:
        return []
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        rows = talk(sock, reader, ["/ip/hotspot/active/print"])
    finally:
        sock.close()
    live = []
    for row in rows:
        user = str(row.get("user") or "")
        mac = str(row.get("mac-address") or "").upper()
        if user not in wanted_users and mac not in wanted_macs:
            continue
        live.append(
            {
                "username": user,
                "ip": row.get("address") or "",
                "mac": mac,
                "uptime": row.get("uptime") or "",
                "idleTime": row.get("idle-time") or "",
                "sessionTimeLeft": row.get("session-time-left") or "",
                "bytesIn": _count(row.get("bytes-in")),
                "bytesOut": _count(row.get("bytes-out")),
            }
        )
    return live


def hotspot_hosts(host, password, macs=None, timeout=8, port=API_PORT, opener=None):
    """Live /ip/hotspot/host rows — every device associated to the hotspot.

    Unlike /ip/hotspot/active this table also lists devices that are on the
    network but have not logged in, which is how a registered-but-unpaid
    device shows as connected-but-not-surfing.
    """
    wanted_macs = {str(mac).strip().upper() for mac in (macs or []) if str(mac or "").strip()}
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        rows = talk(sock, reader, ["/ip/hotspot/host/print"])
    finally:
        sock.close()
    hosts = []
    for row in rows:
        mac = str(row.get("mac-address") or "").upper()
        if wanted_macs and mac not in wanted_macs:
            continue
        hosts.append(
            {
                "mac": mac,
                "ip": row.get("address") or "",
                "authorized": str(row.get("authorized") or "").lower() in {"true", "yes"},
                "bypassed": str(row.get("bypassed") or "").lower() in {"true", "yes"},
                "uptime": row.get("uptime") or "",
                "idleTime": row.get("idle-time") or "",
                "bytesIn": _count(row.get("bytes-in")),
                "bytesOut": _count(row.get("bytes-out")),
            }
        )
    return hosts


def apply_uplink_plan(host, password, commands, timeout=4, port=API_PORT, opener=None):
    """Move ordinary default-route and source NAT preference. Nothing else."""
    connect = opener or socket.create_connection
    try:
        sock = connect((host, port), timeout)
    except OSError as error:
        raise RouterError("The management tunnel did not answer.") from error
    try:
        sock.settimeout(timeout)
        reader = ByteReader(sock)
        login = talk(sock, reader, ["/login", f"=name={API_USER}", f"=password={password}"])
        if any(row.get("ret") for row in login):
            raise RouterError("This router still uses the old API login. RouterOS 7 is required.")
        for command in commands:
            kind = command.get("kind")
            interface = command.get("interface") or ""
            if kind == "preserve-management":
                continue
            if kind == "dhcp-distance":
                rows = talk(sock, reader, ["/ip/dhcp-client/print"])
                for row in _find_interface(rows, interface):
                    talk(
                        sock,
                        reader,
                        [
                            "/ip/dhcp-client/set",
                            f"=.id={_row_id(row)}",
                            f"=default-route-distance={command['distance']}",
                            f"=add-default-route={'yes' if command['addDefaultRoute'] else 'no'}",
                        ],
                    )
            elif kind == "pppoe-distance":
                rows = talk(sock, reader, ["/interface/pppoe-client/print"])
                for row in _find_interface(rows, interface):
                    talk(
                        sock,
                        reader,
                        [
                            "/interface/pppoe-client/set",
                            f"=.id={_row_id(row)}",
                            f"=default-route-distance={command['distance']}",
                            f"=add-default-route={'yes' if command['addDefaultRoute'] else 'no'}",
                        ],
                    )
            elif kind == "static-distance":
                comment = f"isp-centric-wan-{interface}"
                rows = talk(sock, reader, ["/ip/route/print"])
                matched = [row for row in rows if row.get("comment") == comment]
                if matched:
                    for row in matched:
                        talk(sock, reader, ["/ip/route/set", f"=.id={_row_id(row)}", f"=distance={command['distance']}"])
                elif command.get("gateway") and command["distance"] == 1:
                    talk(
                        sock,
                        reader,
                        [
                            "/ip/route/add",
                            "=dst-address=0.0.0.0/0",
                            f"=gateway={command['gateway']}",
                            "=distance=1",
                            f"=comment={comment}",
                        ],
                    )
            elif kind == "nat":
                comment = f"isp-centric-wan-nat-{interface}"
                rows = talk(sock, reader, ["/ip/firewall/nat/print"])
                matched = [row for row in rows if row.get("comment") == comment]
                disabled = "no" if command.get("enabled") else "yes"
                if matched:
                    for row in matched:
                        talk(sock, reader, ["/ip/firewall/nat/set", f"=.id={_row_id(row)}", f"=disabled={disabled}"])
                elif command.get("enabled"):
                    talk(
                        sock,
                        reader,
                        [
                            "/ip/firewall/nat/add",
                            "=chain=srcnat",
                            "=action=masquerade",
                            f"=out-interface={interface}",
                            f"=comment={comment}",
                        ],
                    )
        active = [item["interface"] for item in commands if item.get("kind") == "nat" and item.get("enabled")]
        active_name = active[0] if active else ""
        identity = talk(sock, reader, ["/system/identity/print"])
        interfaces = talk(sock, reader, ["/interface/print"])
        routes = talk(sock, reader, ["/ip/route/print"])
        nat_rows = talk(sock, reader, ["/ip/firewall/nat/print"])
        ping_rows = []
        if active_name:
            try:
                ping_rows = talk(sock, reader, ["/ping", "=address=1.1.1.1", "=count=1", f"=interface={active_name}"])
            except RouterError:
                ping_rows = []
    finally:
        sock.close()
    active = [item["interface"] for item in commands if item.get("kind") == "nat" and item.get("enabled")]
    active_name = active[0] if active else ""
    running = {row.get("name"): row.get("running") == "true" for row in interfaces}
    nat_on = [
        row
        for row in nat_rows
        if row.get("comment") == f"isp-centric-wan-nat-{active_name}" and row.get("disabled") != "true"
    ]
    return {
        "applied": True,
        "managementOk": bool(identity),
        "gatewayOk": bool(active_name) and running.get(active_name, False),
        "routeOk": default_route_ok(routes, active_name),
        "natOk": bool(nat_on),
        "internetOk": ping_reaches(ping_rows),
    }
