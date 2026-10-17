"""Manual single-uplink selection.

Load balancing, automatic failover, and hybrid mode are separate operating
modes. This module never moves traffic unless an administrator confirms a
manual switch. Standby uplinks stay configured.
"""

import json
import re

MODES = (
    "load-balance",
    "failover",
    "hybrid",
    "manual-single",
)

IFACE = re.compile(r"^[A-Za-z0-9_.:-]{1,32}$")
PROVIDER = re.compile(r"^[A-Za-z0-9 ._-]{1,40}$")
GATEWAY = re.compile(r"^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$")
METHODS = {"dhcp", "pppoe", "static"}
OVERRIDE_ROLES = {"director", "supervisor", "it-support"}


class SwitchError(Exception):
    pass


def clean_uplink(raw):
    if not isinstance(raw, dict):
        raise SwitchError("Each uplink needs an interface.")
    interface = str(raw.get("interface", "")).strip()
    provider = str(raw.get("provider", "")).strip()
    method = str(raw.get("method", "")).strip()
    gateway = str(raw.get("gateway", "")).strip()
    if not IFACE.match(interface) or interface == "isp-centric":
        raise SwitchError("Choose an uplink interface that belongs to this router.")
    if not PROVIDER.match(provider):
        raise SwitchError("Enter a provider name using letters, numbers, spaces, or dashes.")
    if method not in METHODS:
        raise SwitchError("Choose DHCP, PPPoE, or a static address for each uplink.")
    if gateway and not GATEWAY.match(gateway):
        raise SwitchError("Enter a gateway address for the uplink.")
    try:
        download = int(raw.get("downloadMbps"))
        upload = int(raw.get("uploadMbps"))
    except (TypeError, ValueError) as error:
        raise SwitchError("Enter the download and upload capacity in Mbps.") from error
    if not (1 <= download <= 100000 and 1 <= upload <= 100000):
        raise SwitchError("Enter the download and upload capacity in Mbps.")
    health = str(raw.get("health") or "unknown")
    if health not in {"healthy", "unhealthy", "unreachable", "unknown"}:
        health = "unknown"
    return {
        "interface": interface,
        "provider": provider,
        "method": method,
        "gateway": gateway,
        "downloadMbps": download,
        "uploadMbps": upload,
        "health": health,
        "eligible": raw.get("eligible", True) is not False,
        "active": bool(raw.get("active")),
    }


def override_allowed(opened_by_role, staff_ready):
    """Unhealthy overrides belong to network staff.

    When no director, supervisor, or IT support account exists yet, the client
    operating the router can still confirm the override.
    """
    if str(opened_by_role or "") in OVERRIDE_ROLES:
        return True
    return not staff_ready


def record_current(uplinks, target_name, mode, confirm):
    """Remember which uplink is already carrying traffic. This does not move it."""
    mode = clean_mode(mode)
    cleaned = [clean_uplink(item) for item in uplinks]
    if mode != "manual-single":
        raise SwitchError("Record the current uplink from Manual Single-Uplink mode.")
    target = next((item for item in cleaned if item["interface"] == target_name), None)
    if target is None or not target["eligible"]:
        raise SwitchError("The selected uplink is not configured on this router.")
    if not confirm:
        raise SwitchError("Confirm that this uplink is already carrying ordinary internet traffic.")
    source = next((item for item in cleaned if item["active"]), None)
    return {
        "source": source["interface"] if source else "",
        "target": target["interface"],
    }


def clean_mode(mode):
    mode = str(mode or "").strip()
    if mode not in MODES:
        raise SwitchError("Choose a WAN operating mode.")
    return mode


def prepare_switch(uplinks, target_name, mode, confirm, override, routeros_version):
    mode = clean_mode(mode)
    cleaned = [clean_uplink(item) for item in uplinks]
    names = [item["interface"] for item in cleaned]
    if len(names) != len(set(names)):
        raise SwitchError("Each uplink interface can be saved once.")
    if mode != "manual-single":
        return _refused("Manual switching is available only in Manual Single-Uplink mode. It does not turn on automatic failover.")
    if len(cleaned) < 2:
        return _refused("Save at least two uplinks before choosing the active one.")
    version = str(routeros_version or "")
    if version[:1] not in {"6", "7"}:
        return _refused("This router version cannot be switched until RouterOS 6 or 7 is known.")
    target = next((item for item in cleaned if item["interface"] == target_name), None)
    if target is None or not target["eligible"]:
        return _refused("The selected uplink is not configured on this router.")
    source = next((item for item in cleaned if item["active"]), None)
    if source and source["interface"] == target["interface"]:
        return _refused("That uplink is already the active uplink.")
    warning = ""
    if target["health"] == "unreachable" and not override:
        return _refused(
            "That uplink is unreachable. Switching is held until an administrator explicitly overrides the restriction.",
            needs_override=True,
            warning="The uplink has no link. Ordinary internet traffic would have nowhere to go.",
        )
    if target["health"] in {"unhealthy", "unknown"} and not override:
        return _refused(
            "That uplink failed its health check. Confirm the warning and override the restriction before switching.",
            needs_override=True,
            warning="The uplink is not known to reach the internet.",
        )
    if target["health"] == "unreachable":
        warning = "The uplink is unreachable. This override can take ordinary internet traffic offline."
    elif target["health"] != "healthy":
        warning = "The uplink is not healthy. Existing sessions may fail if it cannot reach the internet."
    if not confirm:
        return _refused(
            "Confirm the source uplink, target uplink, and the session impact before switching.",
            needs_confirm=True,
            warning=warning,
            source=source["interface"] if source else "",
            target=target["interface"],
        )
    changes = _commands(cleaned, target["interface"], prefer_active=True)
    recovery = _commands(cleaned, source["interface"], prefer_active=True) if source else []
    return {
        "allowed": True,
        "commitActive": False,
        "reason": "",
        "warning": warning,
        "needsOverride": False,
        "needsConfirm": False,
        "source": source["interface"] if source else "",
        "target": target["interface"],
        "impact": [
            "Existing sessions may be interrupted when the public source address changes.",
            "Some applications may need to reconnect.",
            "New connections should use the selected uplink after verification.",
            "Existing connections may continue on the previous path until they close. Connection tracking is not flushed.",
        ],
        "preserves": [
            "Management routes, including the isp-centric tunnel, stay in place.",
            "Standby uplink addresses, DHCP clients, and PPPoE clients stay configured.",
            "LAN, bridge, VLAN, DHCP, DNS, PPPoE, Hotspot, and subscriber settings are not changed.",
        ],
        "changes": changes,
        "recovery": recovery,
    }


def execute(request, device, writer):
    try:
        plan = prepare_switch(
            request.get("uplinks") or [],
            str(request.get("interface") or ""),
            request.get("mode"),
            bool(request.get("confirm")),
            bool(request.get("override")),
            (device or {}).get("routeros_version") or request.get("routerosVersion"),
        )
    except SwitchError as error:
        return "failed", str(error), {"commitActive": False, "needsManualRecovery": False}
    if not plan["allowed"]:
        plan["commitActive"] = False
        plan["needsManualRecovery"] = False
        return "failed", plan["reason"], plan
    report = _apply(writer, plan["changes"])
    if not report["applied"]:
        plan["commitActive"] = False
        plan["needsManualRecovery"] = False
        plan["verification"] = report
        return "failed", "The management connection did not change the router. The active uplink is unchanged.", plan
    internet_ok = report.get("internetOk", True)
    if report["managementOk"] and report["gatewayOk"] and report["routeOk"] and report["natOk"] and internet_ok:
        plan["commitActive"] = True
        plan["verification"] = report
        plan["needsManualRecovery"] = False
        return "succeeded", "Ordinary internet traffic is using the selected uplink.", plan
    recovery = _apply(writer, plan["recovery"]) if plan["recovery"] else {"applied": False}
    plan["verification"] = report
    plan["recoveryReport"] = recovery
    plan["commitActive"] = False
    if recovery.get("applied") and recovery.get("managementOk"):
        plan["needsManualRecovery"] = False
        return "failed", "The new uplink failed verification. The previous uplink was restored.", plan
    plan["needsManualRecovery"] = True
    return "failed", "The uplink change could not be verified and recovery is not confirmed. This router needs manual recovery.", plan


def _apply(writer, commands):
    try:
        report = writer(commands)
    except Exception:
        report = None
    if not isinstance(report, dict):
        return {
            "applied": False,
            "managementOk": False,
            "gatewayOk": False,
            "routeOk": False,
            "natOk": False,
        }
    return report


def _commands(uplinks, active_interface, prefer_active):
    commands = []
    for item in uplinks:
        distance = 1 if item["interface"] == active_interface else 200
        if item["method"] == "dhcp":
            commands.append(
                {
                    "kind": "dhcp-distance",
                    "interface": item["interface"],
                    "distance": distance,
                    "addDefaultRoute": distance == 1,
                }
            )
        elif item["method"] == "pppoe":
            commands.append(
                {
                    "kind": "pppoe-distance",
                    "interface": item["interface"],
                    "distance": distance,
                    "addDefaultRoute": distance == 1,
                }
            )
        else:
            commands.append(
                {
                    "kind": "static-distance",
                    "interface": item["interface"],
                    "gateway": item["gateway"],
                    "distance": distance,
                }
            )
        commands.append(
            {
                "kind": "nat",
                "interface": item["interface"],
                "enabled": item["interface"] == active_interface,
            }
        )
    commands.append({"kind": "preserve-management", "interface": "isp-centric"})
    if not prefer_active:
        return commands
    return commands


def _refused(reason, needs_override=False, needs_confirm=False, warning="", source="", target=""):
    return {
        "allowed": False,
        "commitActive": False,
        "reason": reason,
        "warning": warning,
        "needsOverride": needs_override,
        "needsConfirm": needs_confirm,
        "source": source,
        "target": target,
        "impact": [],
        "preserves": [],
        "changes": [],
        "recovery": [],
    }


def unavailable_writer(_commands):
    return {
        "applied": False,
        "managementOk": False,
        "gatewayOk": False,
        "routeOk": False,
        "natOk": False,
    }
    return json.dumps(
        {
            "interface": payload.get("interface"),
            "confirm": bool(payload.get("confirm")),
            "override": bool(payload.get("override")),
            "mode": payload.get("mode"),
            "uplinks": payload.get("uplinks") or [],
            "routerosVersion": payload.get("routerosVersion") or "",
        }
    )
