"""WireGuard listener for this computer.

The hosted server uses ISP_WG_PUBLIC_KEY and ISP_WG_ENDPOINT. When those are
not set, this computer takes that same role: it keeps the server key, listens
on UDP 51820 at 10.88.0.1, and adds each router as a peer.
"""

import base64
import os
import shutil
import socket
import subprocess
from pathlib import Path

HOST_ADDRESS = "10.88.0.1/24"
TUNNEL_NAME = "isp-centric"
ROOT = Path(__file__).resolve().parent / "wg"
KEY_FILE = ROOT / "server.key"
CONFIG_FILE = ROOT / f"{TUNNEL_NAME}.conf"
SYNC_FILE = ROOT / f"{TUNNEL_NAME}.sync.conf"


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
    apply_config()


def peer_lines(peers):
    from routeros_api import HOTSPOT_NETWORK, PPPOE_NETWORK

    lines = []
    for public_key, tunnel_ip in peers:
        lines.extend(
            [
                "[Peer]",
                f"PublicKey = {public_key}",
                f"AllowedIPs = {tunnel_ip}/32, {PPPOE_NETWORK}, {HOTSPOT_NETWORK}",
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


def apply_config():
    try:
        if os.name == "nt":
            _apply_windows()
        else:
            _apply_posix()
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"event=wireguard error={error}", flush=True)


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


def _apply_posix():
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


def sync_config(wireguard, service_config, sync_target):
    return False


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
                'route print 10.88.0.0 | Out-String | Add-Content $log',
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
