"""Server-side CPE remote access through the management tunnel.

The browser never talks to private PPPoE addresses directly from the public
internet. Staff open a short-lived proxy URL. Prefer a temporary WireGuard /32
to the CPE (local WG server); otherwise fall back to a high-port dst-nat on the
NAS. Surfing clients, portal NAT, and PPPoE profiles are never modified.
"""

from __future__ import annotations

import base64
import http.client
import ipaddress
import re
import secrets
import socket
import threading
import time
from urllib.parse import urlsplit, urlunsplit

import routeros_api
import wg_host

SESSION_SECONDS = max(300, int(__import__("os").environ.get("ISP_REMOTE_ACCESS_SECONDS") or 1800))
PORT_MIN = routeros_api.REMOTE_ACCESS_PORT_MIN
PORT_MAX = routeros_api.REMOTE_ACCESS_PORT_MAX
PREFIX = "/api/pppoe/remote/"
CPE_WEB_PORTS = (80, 8080, 8888)
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-encoding",
    "content-length",
    "host",
}

_LOCK = threading.RLock()
_SESSIONS: dict[str, dict] = {}
_BY_SUBSCRIBER: dict[str, str] = {}
_SWEEPER_STARTED = False


class RemoteAccessError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _start_sweeper():
    global _SWEEPER_STARTED
    with _LOCK:
        if _SWEEPER_STARTED:
            return
        _SWEEPER_STARTED = True
    thread = threading.Thread(target=_sweep_loop, name="remote-access-sweep", daemon=True)
    thread.start()


def clear_orphaned_on_router(tunnel_ip, api_password):
    """Drop leftover remote-access forwards after an API restart. Safe no-op on dead tunnels."""
    try:
        routeros_api.clear_remote_access(tunnel_ip, api_password)
        return True
    except routeros_api.RouterError as error:
        print(f"event=remote-access orphan-clear host={tunnel_ip} error={error}", flush=True)
        return False


def _sweep_loop():
    while True:
        time.sleep(30)
        try:
            expire_sessions()
        except Exception:
            pass


def expire_sessions(now=None):
    now = time.time() if now is None else now
    with _LOCK:
        expired = [token for token, row in _SESSIONS.items() if row["expires_at"] <= now]
    for token in expired:
        close_session(token, reason="expired")


def session_public(row):
    return {
        "url": f"{PREFIX}{row['token']}/",
        "target": f"http://{row['cpe_ip']}:{row['cpe_port']}",
        "expiresAt": int(row["expires_at"]),
        "tunnelIp": row["tunnel_ip"],
        "listenPort": row["listen_port"],
        "mode": row["mode"],
    }


def get_session(token):
    with _LOCK:
        row = _SESSIONS.get(token)
        if not row:
            return None
        if row["expires_at"] <= time.time():
            return None
        return dict(row)


def active_for_subscriber(subscriber_id):
    with _LOCK:
        token = _BY_SUBSCRIBER.get(subscriber_id)
        if not token:
            return None
        row = _SESSIONS.get(token)
        if not row or row["expires_at"] <= time.time():
            return None
        return session_public(row)


def close_session(token, reason="closed"):
    with _LOCK:
        row = _SESSIONS.pop(token, None)
        if row and _BY_SUBSCRIBER.get(row["subscriber_id"]) == token:
            _BY_SUBSCRIBER.pop(row["subscriber_id"], None)
    if not row:
        return False
    if row.get("mode") == "direct":
        wg_host.remove_temporary_host(row["tunnel_ip"], row["cpe_ip"])
    try:
        routeros_api.clear_remote_access(row["tunnel_ip"], row["api_password"], row["comment"])
    except routeros_api.RouterError as error:
        print(f"event=remote-access close={reason} token={token[:8]} error={error}", flush=True)
        return False
    print(f"event=remote-access close={reason} token={token[:8]} cpe={row['cpe_ip']}", flush=True)
    return True


def _pick_listen_port(used):
    for _ in range(40):
        port = PORT_MIN + secrets.randbelow(PORT_MAX - PORT_MIN + 1)
        if port not in used:
            return port
    raise RemoteAccessError(503, "No free remote-access port is available right now.")


def _probe_tcp(host, port, timeout=2.5):
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def _probe_with_retries(host, port, attempts=4, delay=0.35):
    for index in range(attempts):
        if _probe_tcp(host, port, timeout=2.0 + index):
            return True
        time.sleep(delay)
    return False


def _pick_cpe_port(tunnel_ip, api_password, cpe_ip, requested_port):
    ports = [int(requested_port)]
    for candidate in CPE_WEB_PORTS:
        if candidate not in ports:
            ports.append(candidate)
    last = None
    for port in ports:
        try:
            last = routeros_api.diagnose_cpe_web(tunnel_ip, api_password, cpe_ip, cpe_port=port)
        except routeros_api.RouterError as error:
            raise RemoteAccessError(502, str(error)) from error
        if last.get("webOk"):
            return port, last
        if not last.get("pingOk") and not last.get("pppActive"):
            break
    return int(requested_port), last or {}


def _failure_message(diag, cpe_ip, cpe_port):
    if not diag.get("pppActive") and not diag.get("pingOk"):
        return (
            f"The MikroTik cannot reach {cpe_ip}. Confirm the PPPoE session is still online "
            "and the framed IP matches this client."
        )
    if diag.get("pingOk") and not diag.get("webOk"):
        return (
            f"{cpe_ip} answers ping but its web UI did not answer on port {cpe_port}. "
            "Enable WAN/remote HTTP on the CPE, or try the router's real web port."
        )
    return (
        f"The management path to {cpe_ip}:{cpe_port} did not open. "
        "Confirm the CPE is online and its web UI allows the ISP side."
    )


def open_session(
    *,
    client_id,
    subscriber_id,
    tunnel_ip,
    api_password,
    cpe_ip,
    cpe_user="admin",
    cpe_password="",
    cpe_port=80,
):
    _start_sweeper()
    try:
        cpe = ipaddress.ip_address(str(cpe_ip))
        if cpe.version != 4 or not cpe.is_private:
            raise ValueError
    except ValueError as error:
        raise RemoteAccessError(400, "This client has no reachable private router address.") from error
    try:
        nas = ipaddress.ip_address(str(tunnel_ip))
        if nas.version != 4 or not str(nas).startswith(".".join(wg_host.HOST_IP.split(".")[:3]) + "."):
            raise ValueError
    except ValueError as error:
        raise RemoteAccessError(400, "The client's MikroTik tunnel address is not valid.") from error
    cpe_port = int(cpe_port or 80)
    if not (1 <= cpe_port <= 65535):
        raise RemoteAccessError(400, "Enter a valid CPE web port.")
    cpe_user = (cpe_user or "admin").strip()[:64] or "admin"
    cpe_password = str(cpe_password or "")
    if not cpe_password.strip():
        raise RemoteAccessError(400, "Enter the router password.")
    if not api_password:
        raise RemoteAccessError(503, "This MikroTik has no management API password saved.")

    with _LOCK:
        previous = _BY_SUBSCRIBER.get(subscriber_id)
        used = {row["listen_port"] for row in _SESSIONS.values() if row["tunnel_ip"] == tunnel_ip and row.get("listen_port")}
    if previous:
        close_session(previous, reason="replaced")

    cpe_port, diag = _pick_cpe_port(str(nas), api_password, str(cpe), cpe_port)
    token = secrets.token_urlsafe(18)
    comment_key = secrets.token_hex(6)
    comment = routeros_api.remote_access_comment(comment_key)

    # Prefer a temporary WG /32 to the CPE (local server). Fall back to dst-nat.
    direct = wg_host.add_temporary_host(str(nas), str(cpe))
    listen_port = None if direct else _pick_listen_port(used)
    mode = "direct" if direct else "forward"
    try:
        routeros_api.install_remote_access(
            str(nas),
            api_password,
            str(cpe),
            listen_port,
            comment,
            cpe_port=cpe_port,
            server_ip=wg_host.HOST_IP,
        )
    except routeros_api.RouterError as error:
        if direct:
            wg_host.remove_temporary_host(str(nas), str(cpe))
        raise RemoteAccessError(502, str(error)) from error

    if mode == "direct":
        proxy_host, proxy_port = str(cpe), cpe_port
    else:
        proxy_host, proxy_port = str(nas), listen_port

    if not _probe_with_retries(proxy_host, proxy_port):
        try:
            routeros_api.clear_remote_access(str(nas), api_password, comment)
        except routeros_api.RouterError:
            pass
        if direct:
            wg_host.remove_temporary_host(str(nas), str(cpe))
        print(
            f"event=remote-access probe-failed mode={mode} cpe={cpe}:{cpe_port} "
            f"diag={diag} via={proxy_host}:{proxy_port}",
            flush=True,
        )
        raise RemoteAccessError(502, _failure_message(diag, str(cpe), cpe_port))

    now = time.time()
    row = {
        "token": token,
        "client_id": client_id,
        "subscriber_id": subscriber_id,
        "tunnel_ip": str(nas),
        "api_password": api_password,
        "cpe_ip": str(cpe),
        "cpe_port": cpe_port,
        "cpe_user": cpe_user,
        "cpe_password": cpe_password,
        "listen_port": listen_port,
        "proxy_host": proxy_host,
        "proxy_port": proxy_port,
        "mode": mode,
        "comment": comment,
        "created_at": now,
        "expires_at": now + SESSION_SECONDS,
        "last_used": now,
    }
    with _LOCK:
        _SESSIONS[token] = row
        _BY_SUBSCRIBER[subscriber_id] = token
    print(
        f"event=remote-access open mode={mode} token={token[:8]} cpe={cpe}:{cpe_port} via={proxy_host}:{proxy_port}",
        flush=True,
    )
    return session_public(row)


def _rewrite_location(value, prefix):
    parts = urlsplit(value)
    if parts.scheme and parts.scheme not in {"http", "https"}:
        return value
    if parts.netloc:
        path = parts.path or "/"
        return urlunsplit(("", "", prefix.rstrip("/") + path, parts.query, parts.fragment))
    if value.startswith("/"):
        return prefix.rstrip("/") + value
    return value


def _rewrite_cookie(value, prefix):
    bits = []
    for part in value.split(";"):
        item = part.strip()
        lower = item.lower()
        if lower.startswith("path="):
            bits.append(f"Path={prefix}")
        elif lower.startswith("domain="):
            continue
        elif lower.startswith("secure") or lower.startswith("samesite="):
            continue
        else:
            bits.append(item)
    return "; ".join(bits)


def _inject_base(body, content_type, prefix):
    if "text/html" not in (content_type or "").lower():
        return body
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        try:
            text = body.decode("latin-1")
        except UnicodeDecodeError:
            return body
    base = f'<base href="{prefix}">'
    if re.search(r"<base\s", text, flags=re.I):
        text = re.sub(r"<base\s[^>]*>", base, text, count=1, flags=re.I)
    elif re.search(r"<head[^>]*>", text, flags=re.I):
        text = re.sub(r"(<head[^>]*>)", r"\1" + base, text, count=1, flags=re.I)
    else:
        text = base + text
    return text.encode("utf-8")


def proxy_request(handler):
    """Stream one browser request through an open remote-access session."""
    parsed = urlsplit(handler.path)
    path = parsed.path or "/"
    if not path.startswith(PREFIX):
        return False
    rest = path[len(PREFIX) :]
    token, _, suffix = rest.partition("/")
    if not token:
        handler.send_error(404, "Remote access session not found.")
        return True
    row = get_session(token)
    if not row:
        handler.send_error(410, "That remote access session has expired. Open it again from the dashboard.")
        return True
    with _LOCK:
        live = _SESSIONS.get(token)
        if live:
            live["last_used"] = time.time()
            live["expires_at"] = min(live["created_at"] + SESSION_SECONDS * 2, time.time() + SESSION_SECONDS)

    prefix = f"{PREFIX}{token}/"
    upstream_path = "/" + suffix
    if parsed.query:
        upstream_path += "?" + parsed.query

    length = int(handler.headers.get("Content-Length") or 0)
    if length > 2_000_000:
        handler.send_error(413, "That upload is too large for remote access.")
        return True
    body = handler.rfile.read(length) if length else b""

    headers = {}
    for key, value in handler.headers.items():
        if key.lower() in HOP_BY_HOP:
            continue
        if key.lower() == "authorization":
            continue
        headers[key] = value
    headers["Host"] = f"{row['cpe_ip']}:{row['cpe_port']}"
    headers["Connection"] = "close"
    headers["Authorization"] = "Basic " + base64.b64encode(
        f"{row['cpe_user']}:{row['cpe_password']}".encode()
    ).decode()

    conn = http.client.HTTPConnection(row["proxy_host"], row["proxy_port"], timeout=20)
    try:
        conn.request(handler.command, upstream_path, body=body or None, headers=headers)
        upstream = conn.getresponse()
        payload = upstream.read()
        content_type = upstream.getheader("Content-Type") or ""
        payload = _inject_base(payload, content_type, prefix)
        handler.send_response(upstream.status, upstream.reason)
        for key, value in upstream.getheaders():
            lower = key.lower()
            if lower in HOP_BY_HOP:
                continue
            if lower == "location":
                value = _rewrite_location(value, prefix)
            elif lower == "set-cookie":
                value = _rewrite_cookie(value, prefix)
            handler.send_header(key, value)
        handler.send_header("Content-Length", str(len(payload)))
        handler.send_header("Cache-Control", "no-store")
        handler.end_headers()
        if handler.command != "HEAD":
            handler.wfile.write(payload)
    except (OSError, http.client.HTTPException) as error:
        handler.send_error(502, f"The client router page did not answer ({error}).")
    finally:
        conn.close()
    return True
