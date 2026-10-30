"""WireGuard listener for this computer.

The hosted server uses ISP_WG_PUBLIC_KEY and ISP_WG_ENDPOINT. When those are
not set, this computer takes that same role: it keeps the server key, listens
on UDP 51820 at 10.88.0.1, and adds each router as a peer.
"""

import base64
import ipaddress
import os
import shutil
import socket
import subprocess
import time
from pathlib import Path

HOST_ADDRESS = (os.environ.get("ISP_WG_ADDRESS") or "10.88.0.1/24").strip()
HOST_IP = str(ipaddress.ip_interface(HOST_ADDRESS).ip)
TUNNEL_NAME = (os.environ.get("ISP_WG_IFACE") or "isp-centric").strip()
ROOT = Path(__file__).resolve().parent / "wg"
KEY_FILE = ROOT / "server.key"
CONFIG_FILE = ROOT / f"{TUNNEL_NAME}.conf"
SYNC_FILE = ROOT / f"{TUNNEL_NAME}.sync.conf"


def tunnel_network():
    """The tunnel subnet (e.g. 10.88.0.0/24) derived from HOST_ADDRESS."""
    return ipaddress.ip_interface(HOST_ADDRESS).network


def wireguard_keypair():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    private = X25519PrivateKey.generate()
    private_raw = private.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    public_raw = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(private_raw).decode(), base64.b64encode(public_raw).decode()


def local_server():
    return os.environ.get("ISP_WG_LOCAL") == "1"


def listen_port():
    return int(os.environ.get("ISP_WG_PORT") or 51820)


def ensure_server():
    if os.environ.get("ISP_WG_PUBLIC_KEY", "").strip():
        return
    private_key, public_key = load_or_create_keypair()
    os.environ["ISP_WG_PUBLIC_KEY"] = public_key
    os.environ["ISP_WG_ENDPOINT"] = os.environ.get("ISP_WG_ENDPOINT", "").strip() or lan_ip()
    os.environ["ISP_WG_PORT"] = os.environ.get("ISP_WG_PORT", "51820")
    os.environ["ISP_WG_LOCAL"] = "1"
    print(
        f"event=wireguard local endpoint={os.environ['ISP_WG_ENDPOINT']}:{os.environ['ISP_WG_PORT']}",
        flush=True,
    )


def load_or_create_keypair():
    ROOT.mkdir(exist_ok=True)
    if KEY_FILE.exists():
        private_key, _, public_key = KEY_FILE.read_text(encoding="utf-8").partition("\n")
        private_key = private_key.strip()
        public_key = public_key.strip()
        if private_key and public_key:
            return private_key, public_key
    private_key, public_key = wireguard_keypair()
    KEY_FILE.write_text(f"{private_key}\n{public_key}\n", encoding="utf-8")
    # A fresh key means every router peer must be re-onboarded — loud event so
    # a forgotten wg/server.key on a new host is spotted immediately.
    print("event=wireguard status=new-keypair detail=no-server-key-file", flush=True)
    return private_key, public_key


def lan_ip():
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        return probe.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        probe.close()


def sync_peers(rows):
    if not local_server():
        return
    private_key, _ = load_or_create_keypair()
    peers = []
    for row in rows:
        public_key = str(row.get("public_key") or "").strip()
        tunnel_ip = str(row.get("tunnel_ip") or "").strip()
        if public_key and tunnel_ip:
            peers.append((public_key, tunnel_ip))
    CONFIG_FILE.write_text(render_config(private_key, peers), encoding="utf-8")
    SYNC_FILE.write_text(render_sync_config(private_key, peers), encoding="utf-8")
    apply_config(peers)


def peer_networks(tunnel_ip):
    """A peer's AllowedIPs. WireGuard gives each range to one peer only, so
    the client ranges every router shares are never listed; blocked clients
    arrive netmapped into the router's own portal block instead."""
    from routeros_api import portal_map_network

    mapped = portal_map_network(tunnel_ip)
    return [f"{tunnel_ip}/32"] + ([mapped] if mapped else [])


def peer_lines(peers):
    lines = []
    for public_key, tunnel_ip in peers:
        lines.extend(
            [
                "[Peer]",
                f"PublicKey = {public_key}",
                f"AllowedIPs = {', '.join(peer_networks(tunnel_ip))}",
                "",
            ]
        )
    return lines


def render_config(private_key, peers):
    return "\n".join(
        [
            "[Interface]",
            f"PrivateKey = {private_key}",
            f"Address = {HOST_ADDRESS}",
            f"ListenPort = {listen_port()}",
            "",
            *peer_lines(peers),
        ]
    )


def render_sync_config(private_key, peers):
    return "\n".join(
        [
            "[Interface]",
            f"PrivateKey = {private_key}",
            f"ListenPort = {listen_port()}",
            "",
            *peer_lines(peers),
        ]
    )


def runtime_config():
    if os.name == "nt":
        folder = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "ISP-CENTRIC"
    else:
        folder = Path("/etc/wireguard")
    folder.mkdir(exist_ok=True)
    target = folder / CONFIG_FILE.name
    target.write_text(CONFIG_FILE.read_text(encoding="utf-8"), encoding="utf-8")
    sync_target = folder / SYNC_FILE.name
    sync_target.write_text(SYNC_FILE.read_text(encoding="utf-8"), encoding="utf-8")
    return target, sync_target


def tunnel_service_running():
    return tunnel_running()


def apply_config(peers=None):
    try:
        if os.name == "nt":
            _apply_windows()
        else:
            _apply_posix(peers or [])
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"event=wireguard error={error}", flush=True)


def _ensure_posix_routes(peers):
    """wg syncconf updates cryptokey AllowedIPs but never touches the routing
    table; only wg-quick installs routes, and only for peers present at
    start-up. Re-assert the client networks on every sync so portal replies
    to PPPoE/hotspot clients go back down the tunnel instead of the default
    gateway."""
    if shutil.which("ip") is None:
        return
    from routeros_api import HOTSPOT_NETWORK, PPPOE_NETWORK

    networks = set()
    for _key, tunnel_ip in peers:
        networks.update(peer_networks(tunnel_ip))
    commands = [["ip", "route", "replace", network, "dev", TUNNEL_NAME] for network in sorted(networks)]
    # Older releases routed the shared client ranges down the tunnel.
    commands += [["ip", "route", "del", network, "dev", TUNNEL_NAME] for network in (PPPOE_NETWORK, HOTSPOT_NETWORK)]
    for command in commands:
        try:
            subprocess.run(command, check=False, capture_output=True, timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            pass


def _apply_windows():
    wireguard = wireguard_executable()
    if wireguard is None:
        print("event=wireguard status=not-installed", flush=True)
        return
    folder = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "ISP-CENTRIC"
    current = folder / CONFIG_FILE.name
    previous = current.read_text(encoding="utf-8") if current.exists() else ""
    service_config, sync_target = runtime_config()
    updated = service_config.read_text(encoding="utf-8")
    if previous == updated and tunnel_service_running():
        print("event=wireguard status=listening", flush=True)
        return
    if sync_config(wireguard, service_config, sync_target):
        print("event=wireguard status=listening", flush=True)
        return
    elevate_apply(wireguard, service_config, sync_target)


def _apply_posix(peers):
    wg = shutil.which("wg")
    wg_quick = shutil.which("wg-quick")
    if not wg or not wg_quick:
        print("event=wireguard status=not-installed", flush=True)
        return
    if os.geteuid() != 0:
        print("event=wireguard status=needs-root", flush=True)
        return
    current = Path("/etc/wireguard") / CONFIG_FILE.name
    previous = current.read_text(encoding="utf-8") if current.exists() else ""
    try:
        service_config, sync_target = runtime_config()
    except OSError as error:
        print(f"event=wireguard status=write-failed error={error}", flush=True)
        return
    updated = service_config.read_text(encoding="utf-8")
    if previous == updated and tunnel_running():
        _ensure_posix_routes(peers)
        print("event=wireguard status=listening", flush=True)
        return
    if tunnel_running():
        result = subprocess.run(
            [wg, "syncconf", TUNNEL_NAME, str(sync_target)],
            check=False,
            capture_output=True,
            timeout=15,
        )
        if result.returncode == 0:
            _ensure_posix_routes(peers)
            _allow_posix_port()
            print("event=wireguard status=listening", flush=True)
            return
        subprocess.run(
            [wg_quick, "down", str(service_config)],
            check=False,
            capture_output=True,
            timeout=30,
        )
    result = subprocess.run(
        [wg_quick, "up", str(service_config)],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode == 0:
        _ensure_posix_routes(peers)
        _allow_posix_port()
        print("event=wireguard status=listening", flush=True)
    else:
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        error = detail[-1] if detail else f"exit {result.returncode}"
        print(f"event=wireguard status=start-failed error={error}", flush=True)


def _allow_posix_port():
    if shutil.which("ufw"):
        try:
            subprocess.run(
                ["ufw", "allow", f"{listen_port()}/udp"],
                check=False,
                capture_output=True,
                timeout=15,
            )
            # Everything the routers send back (RADIUS, portal, API replies)
            # arrives on this interface — ufw's default deny would drop it.
            subprocess.run(
                ["ufw", "allow", "in", "on", TUNNEL_NAME],
                check=False,
                capture_output=True,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass


def wg_executable():
    wireguard = wireguard_executable()
    if wireguard is None:
        return None
    candidate = wireguard.with_name("wg.exe")
    return candidate if candidate.exists() else None


def sync_config(wireguard, service_config, sync_target):
    """Apply only the peer diffs to the live tunnel so connected routers keep
    their sessions. Returns False when wg.exe cannot drive the interface (it
    is missing, the tunnel is down, or the process lacks elevation) — the
    caller then falls back to a service reinstall."""
    if not tunnel_service_running():
        return False
    wg = wg_executable()
    if wg is None:
        return False
    try:
        result = subprocess.run(
            [str(wg), "syncconf", TUNNEL_NAME, str(sync_target)],
            check=False,
            capture_output=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def elevate_apply(wireguard, service_config, sync_target):
    script = sync_target.parent / "apply.ps1"
    log = sync_target.parent / "apply.log"
    script.write_text(
        "\n".join(
            [
                f'$wireguard = "{wireguard}"',
                f'$service = "{service_config}"',
                f'$log = "{log}"',
                '"reload" | Set-Content $log -Encoding ascii',
                '& $wireguard /uninstalltunnelservice isp-centric *>> $log',
                'for ($i = 0; $i -lt 20; $i++) { if (-not (Get-Service "WireGuardTunnel`$isp-centric" -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 500 }',
                '& $wireguard /installtunnelservice $service *>> $log',
                '"install-exit=$LASTEXITCODE" | Add-Content $log',
                'Start-Sleep -Seconds 2',
                'sc.exe query "WireGuardTunnel`$isp-centric" | Out-String | Add-Content $log',
                f'netsh advfirewall firewall add rule name="ISP CENTRIC WireGuard" dir=in action=allow protocol=UDP localport={listen_port()} | Out-Null',
                'netsh advfirewall firewall add rule name="ISP CENTRIC Tunnel ICMP" dir=in action=allow protocol=icmpv4 | Out-Null',
                f'route print {tunnel_network().network_address} | Out-String | Add-Content $log',
                'exit $LASTEXITCODE',
            ]
        ),
        encoding="utf-8",
    )
    print("event=wireguard status=waiting-for-admin", flush=True)
    subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            f"Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{script}' -Verb RunAs -Wait",
        ],
        check=False,
        timeout=90,
    )


def wireguard_executable():
    candidate = Path(r"C:\Program Files\WireGuard\wireguard.exe")
    if candidate.exists():
        return candidate
    return None


_TUNNEL_STATE = {"at": 0.0, "running": False}


def tunnel_running_cached(ttl=5):
    """Health-check view of the tunnel. The real check spawns `sc query`/
    inspects sysfs every call — too costly to run on each /api/health poll."""
    now = time.time()
    if now - _TUNNEL_STATE["at"] < ttl:
        return _TUNNEL_STATE["running"]
    _TUNNEL_STATE["at"] = now
    _TUNNEL_STATE["running"] = tunnel_running()
    return _TUNNEL_STATE["running"]


def tunnel_running():
    if os.name == "nt":
        try:
            result = subprocess.run(
                ["sc", "query", f"WireGuardTunnel${TUNNEL_NAME}"],
                check=False,
                capture_output=True,
                text=True,
            )
        except OSError:
            return False
        return "RUNNING" in result.stdout
    return Path(f"/sys/class/net/{TUNNEL_NAME}").exists()
