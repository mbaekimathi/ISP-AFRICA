"""PPPoE registration checks, billing dates, and RADIUS attribute plans.

These functions do not touch the database. Callers pass the records they already loaded.
"""

import calendar
import ipaddress
import re
import secrets
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation

PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789"
CYCLES = {"weekly", "monthly", "quarterly", "custom"}
PHONE_PATTERN = re.compile(r"^254[17]\d{8}$")
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]{3,64}$")
RESTRICTED_GROUP = "pppoe-restricted"
EXPIRED_GROUP = "pppoe-expired"
RESTRICTED_SESSION_SECONDS = 900
RESTRICTED_RATE_LIMIT = "64k/64k"


def normalize_phone(value):
    digits = "".join(character for character in str(value or "") if character.isdigit())
    if digits.startswith("254") and len(digits) == 12:
        normalized = digits
    elif digits.startswith("0") and len(digits) == 10:
        normalized = "254" + digits[1:]
    elif len(digits) == 9 and digits[0] in "17":
        normalized = "254" + digits
    else:
        return None
    if not PHONE_PATTERN.fullmatch(normalized):
        return None
    return normalized


def phone_variants(value):
    """Every Kenyan format this value could be dialed as. Empty unless the digits look like a phone."""
    digits = "".join(character for character in str(value or "") if character.isdigit())
    if digits.startswith("254") and len(digits) == 12 and digits[3] in "17":
        return {digits, "0" + digits[3:], digits[3:]}
    if digits.startswith("0") and len(digits) == 10 and digits[1] in "17":
        return {digits, "254" + digits[1:], digits[1:]}
    if len(digits) == 9 and digits[0] in "17":
        return {digits, "0" + digits, "254" + digits}
    return set()


def generate_password(length=10):
    count = 10 if not isinstance(length, int) else min(12, max(8, length))
    return "".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(count))


def password_ok(value):
    text = str(value or "")
    if not 8 <= len(text) <= 12:
        return False
    return all(character in PASSWORD_ALPHABET for character in text)


def add_months(day, months):
    index = day.month - 1 + months
    year = day.year + index // 12
    month = index % 12 + 1
    last = calendar.monthrange(year, month)[1]
    return date(year, month, min(day.day, last))


def cycle_days(cycle, custom_days, start):
    if cycle == "weekly":
        return 7
    if cycle == "quarterly":
        return (add_months(start, 3) - start).days
    if cycle == "custom":
        return custom_days
    return (add_months(start, 1) - start).days


def add_cycle(start, cycle, custom_days):
    if cycle == "weekly":
        return start + timedelta(days=7)
    if cycle == "quarterly":
        return add_months(start, 3)
    if cycle == "custom":
        return start + timedelta(days=custom_days)
    return add_months(start, 1)


def parse_day(value):
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.strptime(text[:10], "%Y-%m-%d").date()
    except ValueError:
        return "invalid"


def money(value, label):
    try:
        amount = Decimal(str(value).strip())
    except (InvalidOperation, AttributeError):
        return None
    if amount < 0 or amount > Decimal("99999999.99") or amount.as_tuple().exponent < -2:
        return None
    return amount.quantize(Decimal("0.01"))


def ipv4_list(start, end):
    try:
        first = ipaddress.IPv4Address(start)
        last = ipaddress.IPv4Address(end)
    except ipaddress.AddressValueError:
        return []
    if int(last) < int(first) or int(last) - int(first) > 1024:
        return []
    return [str(ipaddress.IPv4Address(number)) for number in range(int(first), int(last) + 1)]


def rate_limit(package):
    return f"{int(package['uploadMbps'])}M/{int(package['downloadMbps'])}M"


def issue(items, field, message):
    items.append({"field": field, "message": message})


def validate_pppoe_provisioning(payload, context, today=None):
    """Return errors, warnings, and a normalized plan. Errors block every write."""
    today = today or date.today()
    payload = payload or {}
    context = context or {}
    errors = []
    warnings = []
    first = str(payload.get("firstName", "")).strip()
    last = str(payload.get("lastName", "")).strip()
    if len(first) < 2 or len(first) > 60:
        issue(errors, "firstName", "Enter a first name of at least 2 characters.")
    if len(last) < 2 or len(last) > 60:
        issue(errors, "lastName", "Enter a last name of at least 2 characters.")
    phone = normalize_phone(payload.get("phone"))
    if not phone:
        issue(errors, "phone", "Enter a Kenyan phone number, such as 07…, 01…, or +254….")
    email = str(payload.get("email", "")).strip()
    if email and (len(email) > 120 or not EMAIL_PATTERN.fullmatch(email)):
        issue(errors, "email", "Enter a valid email address, or leave it empty.")
    building = str(payload.get("buildingName", "")).strip()
    house = str(payload.get("houseNumber", "")).strip()
    if len(building) > 80:
        issue(errors, "buildingName", "Enter a shorter building name.")
    if len(house) > 40:
        issue(errors, "houseNumber", "Enter a shorter house number.")
    entered_phone = "".join(character for character in str(payload.get("phone") or "") if character.isdigit())
    username = str(payload.get("username") or entered_phone or "").strip()
    if not USERNAME_PATTERN.fullmatch(username):
        issue(errors, "username", "Use 3 to 64 letters, numbers, hyphens, or underscores.")
    else:
        stored = {str(item) for item in context.get("usernames", [])}
        taken = {item.lower() for item in stored}
        for item in stored:
            taken.update(alias.lower() for alias in phone_variants(item))
        collision = username.lower() in taken or bool({alias.lower() for alias in phone_variants(username)} & taken)
        if collision:
            issue(errors, "username", "That PPPoE username is already used.")
    if phone and phone in {str(item) for item in context.get("phones", [])}:
        issue(errors, "phone", "That phone number is already registered.")
    password = str(payload.get("password", ""))
    if not password_ok(password):
        issue(errors, "password", "Use 8 to 12 characters without O or l. A phone number like 0723864156 works.")
    method = str(payload.get("authMethod") or "mschap2").strip().lower()
    if method not in {"mschap2", "chap"}:
        issue(errors, "authMethod", "Choose MS-CHAPv2 or CHAP.")
    router = context.get("router")
    if not router:
        issue(errors, "routerId", "Choose a MikroTik router.")
    elif router.get("status") != "active":
        issue(errors, "routerId", "That router is not active.")
    elif router.get("tunnelStatus") != "up":
        issue(warnings, "routerId", "That router is not confirmed reachable. The account will still be saved.")
    if router and not str(router.get("site") or "").strip():
        issue(warnings, "routerId", "This router has no site, so the customer network was not confirmed.")
    package = context.get("package")
    if not package:
        issue(errors, "packageId", "Choose a package for the selected router.")
    elif package.get("status") != "active":
        issue(errors, "packageId", "That package is not active.")
    elif router and str(router.get("id")) not in {str(item) for item in package.get("routers", [])}:
        issue(errors, "packageId", "That package is not linked to the selected router.")
    elif int(package.get("downloadMbps") or 0) < 1 or int(package.get("uploadMbps") or 0) < 1:
        issue(errors, "packageId", "That package has no rate limit for this router.")
    serial = str(payload.get("serial") or "").strip()
    if len(serial) > 64:
        issue(errors, "serial", "Enter a shorter serial number.")
    elif serial and serial.lower() in {item.lower() for item in context.get("serials", [])}:
        issue(errors, "serial", "That serial number is already registered.")
    start = parse_day(payload.get("startDate"))
    if start == "invalid":
        issue(errors, "startDate", "Enter a package start date as YYYY-MM-DD, or leave it empty.")
        start = None
    elif start and (start < date(2015, 1, 1) or start > today + timedelta(days=366)):
        issue(errors, "startDate", "Enter a start date that is not far in the past or more than a year ahead.")
    cycle = str(payload.get("billingCycle") or "monthly").strip()
    if cycle not in CYCLES:
        issue(errors, "billingCycle", "Choose a weekly, monthly, quarterly, or custom billing cycle.")
    custom_days = 0
    if cycle == "custom":
        try:
            custom_days = int(payload.get("cycleDays"))
        except (TypeError, ValueError):
            custom_days = 0
        if not 1 <= custom_days <= 366:
            issue(errors, "cycleDays", "Enter a custom cycle from 1 to 366 days.")
    price = money(payload.get("price", package.get("price") if package else ""), "price")
    if price is None:
        issue(errors, "price", "Enter a monthly price with up to two decimal places.")
    discount = money(payload.get("discount") or "0", "discount")
    reason = str(payload.get("discountReason") or "").strip()
    if discount is None:
        issue(errors, "discount", "Enter a discount with up to two decimal places, or leave it empty.")
    elif discount > 0 and not reason:
        issue(errors, "discountReason", "Enter a reason for the discount.")
    elif price is not None and discount is not None and discount > price:
        issue(errors, "discount", "Enter a discount that is not higher than the price.")
    initial = money(payload.get("initialPayment") or "0", "initial")
    if initial is None:
        issue(errors, "initialPayment", "Enter an initial payment with up to two decimal places, or leave it empty.")
    try:
        grace = int(payload.get("graceDays") if payload.get("graceDays") not in (None, "") else 3)
    except (TypeError, ValueError):
        grace = -1
    if not 0 <= grace <= 30:
        issue(errors, "graceDays", "Enter a grace period from 0 to 30 days.")
    try:
        sessions = int(payload.get("sessionLimit") if payload.get("sessionLimit") not in (None, "") else 1)
    except (TypeError, ValueError):
        sessions = 0
    if not 1 <= sessions <= 5:
        issue(errors, "sessionLimit", "Enter a simultaneous session limit from 1 to 5.")
    try:
        mtu = int(payload.get("mtu") if payload.get("mtu") not in (None, "") else 1492)
    except (TypeError, ValueError):
        mtu = 0
    if not 1400 <= mtu <= 1500:
        issue(errors, "mtu", "Enter an MTU from 1400 to 1500.")
    elif not 1480 <= mtu <= 1492:
        issue(warnings, "mtu", "That MTU is outside the usual PPPoE range of 1480 to 1492.")
    interface = str(payload.get("accessInterface") or "").strip()
    if len(interface) > 32:
        issue(errors, "accessInterface", "Enter a shorter access interface name.")
    elif interface:
        known = context.get("interfaces")
        if known is None:
            issue(warnings, "accessInterface", "The access interface was not confirmed on the router.")
        elif interface not in known:
            issue(errors, "accessInterface", "That VLAN or access interface is not configured on the router.")
    static_ip = str(payload.get("staticIp") or "").strip()
    assigned_ip = None
    pool_name = "pppoe-pool"
    pool = context.get("pool")
    addresses = ipv4_list(pool.get("start"), pool.get("end")) if pool else []
    used = {str(item) for item in context.get("usedIps", [])}
    if static_ip:
        try:
            ipaddress.IPv4Address(static_ip)
        except ipaddress.AddressValueError:
            issue(errors, "staticIp", "Enter a valid static IPv4 address, or leave it empty.")
        else:
            if not addresses:
                issue(errors, "staticIp", "Configure an approved address range before assigning a static IP.")
            elif static_ip not in addresses:
                issue(errors, "staticIp", "That static IP is outside the approved range.")
            elif static_ip in used:
                issue(errors, "staticIp", "That static IP is already assigned.")
            else:
                assigned_ip = static_ip
                pool_name = None
    elif addresses:
        free = [item for item in addresses if item not in used]
        if not free:
            issue(errors, "staticIp", "The address pool for this router is exhausted.")
        else:
            assigned_ip = free[0]
            pool_name = None
    else:
        issue(warnings, "staticIp", "No approved address range is saved. RADIUS will use the pool name pppoe-pool.")
    auto_renew = bool(payload.get("autoRenew", True))
    if errors:
        return {"errors": errors, "warnings": warnings, "normalized": None}
    active = bool(start and start <= today)
    anchor = start or today
    next_due = add_cycle(anchor, cycle, custom_days) if start else None
    expiry = next_due + timedelta(days=grace) if next_due else None
    return {
        "errors": [],
        "warnings": warnings,
        "normalized": {
            "firstName": first,
            "lastName": last,
            "phone": phone,
            "email": email,
            "buildingName": building,
            "houseNumber": house,
            "username": username,
            "password": password,
            "routerId": router["id"],
            "packageId": package["id"],
            "serial": serial,
            "staticIp": assigned_ip,
            "poolName": pool_name,
            "startDate": start.isoformat() if start else None,
            "status": "active" if active else "pending_activation",
            "radiusActive": active,
            "price": format(price, ".2f"),
            "billingCycle": cycle,
            "cycleDays": cycle_days(cycle, custom_days, anchor),
            "initialPayment": format(initial, ".2f"),
            "discount": format(discount, ".2f"),
            "discountReason": reason,
            "graceDays": grace,
            "autoRenew": auto_renew,
            "nextDueDate": next_due.isoformat() if next_due else None,
            "expiryDate": expiry.isoformat() if expiry else None,
            "sessionLimit": sessions,
            "accessInterface": interface,
            "mtu": mtu,
            "rateLimit": rate_limit(package),
            "groupName": f"pppoe-{package['id']}" if active else RESTRICTED_GROUP,
            "authMethod": method,
        },
    }


def session_timeout_seconds(expiry_iso, now=None):
    """Seconds until the end of the expiry day, so sessions die at the cutoff."""
    if not expiry_iso:
        return None
    day = parse_day(expiry_iso)
    if not day or day == "invalid":
        return None
    now = now or datetime.now()
    cutoff = datetime(day.year, day.month, day.day) + timedelta(days=1)
    remaining = int((cutoff - now).total_seconds())
    return min(max(60, remaining), 45 * 86400)


def radius_plan(plan):
    """Attributes FreeRADIUS SQL should hold.

    Every account keeps working credentials so it can dial. Active
    subscriptions land in the pppoe-subscribed address list; suspended
    accounts land in pppoe-suspended (paused notice) and every other
    blocked account lands in pppoe-expired (recharge portal). Both are
    dropped from internet access by the enforced router.
    """
    active = bool(plan.get("radiusActive"))
    checks = [
        {"attribute": "Cleartext-Password", "op": ":=", "value": plan["password"]},
        {"attribute": "Simultaneous-Use", "op": ":=", "value": str(plan["sessionLimit"])},
    ]
    replies = []
    if plan.get("staticIp"):
        replies.append({"attribute": "Framed-IP-Address", "op": ":=", "value": plan["staticIp"]})
    elif plan.get("poolName"):
        replies.append({"attribute": "Framed-Pool", "op": ":=", "value": plan["poolName"]})
    if active:
        seconds = session_timeout_seconds(plan.get("expiryDate"))
        if seconds:
            replies.append({"attribute": "Session-Timeout", "op": ":=", "value": str(seconds)})
        group = plan["groupName"]
        group_replies = [
            {"attribute": "Mikrotik-Rate-Limit", "op": ":=", "value": plan["rateLimit"]},
            {"attribute": "Mikrotik-Address-List", "op": ":=", "value": "pppoe-subscribed"},
        ]
    else:
        replies.append({"attribute": "Session-Timeout", "op": ":=", "value": str(RESTRICTED_SESSION_SECONDS)})
        suspended = plan.get("status") == "suspended"
        group = RESTRICTED_GROUP if suspended else EXPIRED_GROUP
        group_replies = [
            {"attribute": "Mikrotik-Rate-Limit", "op": ":=", "value": RESTRICTED_RATE_LIMIT},
            {"attribute": "Mikrotik-Address-List", "op": ":=", "value": "pppoe-suspended" if suspended else "pppoe-expired"},
        ]
    return {"checks": checks, "replies": replies, "group": group, "groupReplies": group_replies}


def router_status(status, open_sessions, expiry_date, today, last_action="", tunnel_status="up"):
    """Router-facing state shown on the PPPoE client list.

    An open radacct session is the ground truth for "online" — it outranks
    tunnel_status, which only reflects whether the management API answered
    recently and can flap while sessions stay up."""
    sessions = int(open_sessions or 0)
    if status == "pending_activation":
        return "pending_activation"
    if last_action == "disconnect" and sessions:
        return "disconnecting"
    if status == "expired" or (status == "active" and expiry_date and today > expiry_date):
        return "expired_online" if sessions else "expired"
    if status == "suspended" and sessions:
        return "suspended_online"
    if status == "suspended":
        return "disconnected"
    if status in {"disabled", "disconnected", "cancelled"}:
        return "expired_online" if sessions else "expired"
    if status == "active" and sessions:
        return "surfing"
    if status == "active" and tunnel_status != "up":
        return "disconnected"
    return "not_surfing"


def analysis_bucket(status, open_sessions, expiry_date, today, last_action="", tunnel_status="up"):
    """Card groups: surfing, not surfing, expired, and disconnected."""
    state = router_status(status, open_sessions, expiry_date, today, last_action, tunnel_status)
    if state in {"disconnecting", "disconnected", "suspended_online"} or status in {"suspended", "disabled"}:
        return "disconnected"
    if state in {"expired", "expired_online"}:
        return "expired"
    if state == "surfing":
        return "surfing"
    return "not_surfing"


def empty_client_analysis():
    return {"surfing": 0, "notSurfing": 0, "expired": 0, "disconnected": 0, "total": 0}


def tally_client_analysis(rows, today):
    counts = {"pppoe": empty_client_analysis(), "hotspot": empty_client_analysis()}
    fields = {
        "surfing": "surfing",
        "not_surfing": "notSurfing",
        "expired": "expired",
        "disconnected": "disconnected",
    }
    for row in rows:
        service = row.get("service") if row.get("service") in counts else "pppoe"
        bucket = analysis_bucket(
            row.get("status"),
            row.get("open_sessions") or 0,
            row.get("expiry_date"),
            today,
            row.get("last_action") or "",
            row.get("tunnel_status") or "up",
        )
        counts[service][fields[bucket]] += 1
        counts[service]["total"] += 1
    return counts


def connection_label(open_sessions, any_sessions, tunnel_status):
    if open_sessions:
        return "online"
    if not any_sessions or tunnel_status != "up":
        return "unknown"
    return "offline"


def duplicate_session_action(open_count, limit, policy="reject_new"):
    if open_count < limit:
        return "allow"
    if policy == "kick_old":
        return "kick_old"
    return "reject_new"


def job_transition(status, start_date, expiry_date, today):
    """Expiry dates already include the grace period."""
    if status == "pending_activation" and start_date and start_date <= today:
        return "active"
    if status == "active" and expiry_date and today > expiry_date:
        return "expired"
    return None


def can_reactivate(billing_status, override):
    return billing_status == "paid" or bool(override)


def renewal_dates(current_expiry, cycle, custom_days, grace_days, today, paid):
    if not paid:
        return None
    anchor = current_expiry if current_expiry and current_expiry > today else today
    due = add_cycle(anchor, cycle, custom_days)
    return {"nextDueDate": due.isoformat(), "expiryDate": (due + timedelta(days=grace_days)).isoformat()}


def prorate_credit(price, next_due, today, period_days):
    if not next_due or next_due <= today or period_days <= 0:
        return Decimal("0.00")
    remaining = (next_due - today).days
    credit = (Decimal(price) * Decimal(remaining) / Decimal(period_days)).quantize(Decimal("0.01"))
    return min(credit, Decimal(price))
