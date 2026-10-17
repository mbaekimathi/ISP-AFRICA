"""Saved PPPoE subscribers, billing rows, and FreeRADIUS SQL tables."""

import hashlib
import hmac
import json
import secrets
import socket
import time
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal

import pppoe_service
import routeros_api

CHECKS = {}


class PppoeError(Exception):
    def __init__(self, status, message, details=None):
        super().__init__(message)
        self.status = status
        self.details = details or {}


def ensure_schema(cursor):
    for column, definition in (
        ("ip_pool_start", "ip_pool_start VARCHAR(15) NULL"),
        ("ip_pool_end", "ip_pool_end VARCHAR(15) NULL"),
        ("pppoe_interface", "pppoe_interface VARCHAR(32) NULL"),
    ):
        cursor.execute("SHOW COLUMNS FROM isp_mikrotik_devices LIKE %s", (column,))
        if cursor.fetchone() is None:
            cursor.execute(f"ALTER TABLE isp_mikrotik_devices ADD COLUMN {definition}")
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS pppoe_subscribers (
          id CHAR(36) NOT NULL PRIMARY KEY,
          client_id CHAR(36) NOT NULL,
          first_name VARCHAR(60) NOT NULL,
          last_name VARCHAR(60) NOT NULL,
          phone VARCHAR(20) NOT NULL,
          email VARCHAR(120) NOT NULL DEFAULT '',
          building_name VARCHAR(80) NOT NULL DEFAULT '',
          house_number VARCHAR(40) NOT NULL DEFAULT '',
          pppoe_username VARCHAR(64) NOT NULL,
          password_sealed VARCHAR(255) NOT NULL,
          router_id CHAR(36) NOT NULL,
          package_id CHAR(36) NOT NULL,
          router_serial VARCHAR(64) NULL,
          static_ip VARCHAR(15) NULL,
          session_limit INT NOT NULL DEFAULT 1,
          access_interface VARCHAR(32) NOT NULL DEFAULT '',
          mtu INT NOT NULL DEFAULT 1492,
          status ENUM('pending_activation','active','suspended','expired','disconnected','cancelled') NOT NULL DEFAULT 'pending_activation',
          service ENUM('pppoe','hotspot') NOT NULL DEFAULT 'pppoe',
          start_date DATE NULL,
          created_by CHAR(36) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_pppoe_username (pppoe_username),
          UNIQUE KEY uq_pppoe_phone (phone),
          UNIQUE KEY uq_pppoe_serial (router_serial),
          KEY idx_pppoe_client (client_id, status)
        )
        """
    )
    cursor.execute("SHOW COLUMNS FROM pppoe_subscribers LIKE 'service'")
    if cursor.fetchone() is None:
        cursor.execute("ALTER TABLE pppoe_subscribers ADD COLUMN service ENUM('pppoe','hotspot') NOT NULL DEFAULT 'pppoe'")
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS pppoe_subscriptions (
          id CHAR(36) NOT NULL PRIMARY KEY,
          subscriber_id CHAR(36) NOT NULL,
          package_id CHAR(36) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          billing_cycle ENUM('weekly','monthly','quarterly','custom') NOT NULL DEFAULT 'monthly',
          cycle_days INT NOT NULL DEFAULT 30,
          start_date DATE NULL,
          next_due_date DATE NULL,
          expiry_date DATE NULL,
          grace_days INT NOT NULL DEFAULT 3,
          auto_renew TINYINT NOT NULL DEFAULT 1,
          billing_status ENUM('pending','paid','overdue','suspended','cancelled') NOT NULL DEFAULT 'pending',
          discount DECIMAL(10,2) NOT NULL DEFAULT 0,
          discount_reason VARCHAR(160) NOT NULL DEFAULT '',
          UNIQUE KEY uq_pppoe_subscription (subscriber_id)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS pppoe_invoices (
          id CHAR(36) NOT NULL PRIMARY KEY,
          client_id CHAR(36) NOT NULL,
          subscriber_id CHAR(36) NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          purpose VARCHAR(40) NOT NULL,
          status ENUM('pending','paid','void') NOT NULL DEFAULT 'pending',
          mpesa_reference VARCHAR(40) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_pppoe_invoice (subscriber_id, status)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS pppoe_payments (
          id CHAR(36) NOT NULL PRIMARY KEY,
          client_id CHAR(36) NOT NULL,
          subscriber_id CHAR(36) NOT NULL,
          invoice_id CHAR(36) NULL,
          amount DECIMAL(10,2) NOT NULL,
          method VARCHAR(20) NOT NULL,
          mpesa_reference VARCHAR(40) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_pppoe_payment (subscriber_id, created_at)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS pppoe_events (
          id CHAR(36) NOT NULL PRIMARY KEY,
          client_id CHAR(36) NOT NULL,
          subscriber_id CHAR(36) NOT NULL,
          actor_id CHAR(36) NOT NULL,
          action VARCHAR(40) NOT NULL,
          reason VARCHAR(160) NOT NULL DEFAULT '',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_pppoe_event (subscriber_id, created_at)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS isp_radius_nas (
          router_id CHAR(36) NOT NULL PRIMARY KEY,
          nasname VARCHAR(128) NOT NULL,
          secret_sealed VARCHAR(255) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS radcheck (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(64) NOT NULL DEFAULT '',
          attribute VARCHAR(64) NOT NULL DEFAULT '',
          op CHAR(2) NOT NULL DEFAULT '==',
          value VARCHAR(253) NOT NULL DEFAULT '',
          KEY username (username(32))
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS radreply (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(64) NOT NULL DEFAULT '',
          attribute VARCHAR(64) NOT NULL DEFAULT '',
          op CHAR(2) NOT NULL DEFAULT ':=',
          value VARCHAR(253) NOT NULL DEFAULT '',
          KEY username (username(32))
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS radusergroup (
          username VARCHAR(64) NOT NULL DEFAULT '',
          groupname VARCHAR(64) NOT NULL DEFAULT '',
          priority INT NOT NULL DEFAULT 1,
          KEY username (username(32))
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS radgroupreply (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          groupname VARCHAR(64) NOT NULL DEFAULT '',
          attribute VARCHAR(64) NOT NULL DEFAULT '',
          op CHAR(2) NOT NULL DEFAULT ':=',
          value VARCHAR(253) NOT NULL DEFAULT '',
          KEY groupname (groupname(32))
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS radacct (
          radacctid BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          acctsessionid VARCHAR(64) NOT NULL DEFAULT '',
          acctuniqueid VARCHAR(32) NOT NULL DEFAULT '',
          username VARCHAR(64) NOT NULL DEFAULT '',
          nasipaddress VARCHAR(15) NOT NULL DEFAULT '',
          acctstarttime DATETIME NULL,
          acctupdatetime DATETIME NULL,
          acctstoptime DATETIME NULL,
          acctsessiontime INT UNSIGNED NULL,
          acctinputoctets BIGINT NULL,
          acctoutputoctets BIGINT NULL,
          callingstationid VARCHAR(50) NULL,
          acctterminatecause VARCHAR(32) NULL,
          framedipaddress VARCHAR(15) NULL,
          KEY username (username),
          KEY acctstoptime (acctstoptime)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS nas (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          nasname VARCHAR(128) NOT NULL,
          shortname VARCHAR(32) NULL,
          type VARCHAR(30) NULL DEFAULT 'mikrotik',
          ports INT NULL,
          secret VARCHAR(255) NOT NULL DEFAULT '',
          description VARCHAR(200) NULL,
          UNIQUE KEY nasname (nasname)
        )
        """
    )


def client_id_from(cursor, token):
    raw = (token or {}).get("isp_client_session")
    if not raw:
        raise PppoeError(401, "Sign in to the ISP client account before managing PPPoE clients.")
    cursor.execute(
        "SELECT account_id FROM isp_sessions WHERE token = %s AND account_kind = 'client'",
        (raw,),
    )
    row = cursor.fetchone()
    if not row:
        raise PppoeError(401, "Sign in to the ISP client account before managing PPPoE clients.")
    return row["account_id"]


def allow_username_check(client_id):
    now = time.time()
    recent = [item for item in CHECKS.get(client_id, []) if now - item < 60]
    if len(recent) >= 30:
        return False
    recent.append(now)
    CHECKS[client_id] = recent
    return True


def stamp(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def as_day(value):
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    parsed = pppoe_service.parse_day(value)
    return None if parsed == "invalid" else parsed


def write_radius(cursor, username, plan):
    built = pppoe_service.radius_plan(plan)
    cursor.execute("DELETE FROM radcheck WHERE username = %s", (username,))
    cursor.execute("DELETE FROM radreply WHERE username = %s", (username,))
    cursor.execute("DELETE FROM radusergroup WHERE username = %s", (username,))
    for row in built["checks"]:
        cursor.execute(
            "INSERT INTO radcheck (username, attribute, op, value) VALUES (%s, %s, %s, %s)",
            (username, row["attribute"], row["op"], row["value"]),
        )
    for row in built["replies"]:
        cursor.execute(
            "INSERT INTO radreply (username, attribute, op, value) VALUES (%s, %s, %s, %s)",
            (username, row["attribute"], row["op"], row["value"]),
        )
    cursor.execute(
        "INSERT INTO radusergroup (username, groupname, priority) VALUES (%s, %s, 1)",
        (username, built["group"]),
    )
    cursor.execute("DELETE FROM radgroupreply WHERE groupname = %s", (built["group"],))
    for row in built["groupReplies"]:
        cursor.execute(
            "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (%s, %s, %s, %s)",
            (built["group"], row["attribute"], row["op"], row["value"]),
        )
    return built


def ensure_nas(cursor, router):
    nasname = router.get("tunnel_ip") or router["id"]
    cursor.execute("SELECT secret_sealed FROM isp_radius_nas WHERE router_id = %s", (router["id"],))
    existing = cursor.fetchone()
    if existing:
        try:
            known = routeros_api.open_password(existing["secret_sealed"])
        except routeros_api.RouterError:
            return None
        cursor.execute(
            """
            INSERT INTO nas (nasname, shortname, type, secret, description)
            VALUES (%s, %s, 'mikrotik', %s, %s)
            ON DUPLICATE KEY UPDATE secret = VALUES(secret), description = VALUES(description)
            """,
            (nasname, str(router.get("name") or "")[:32], known, router["id"]),
        )
        cursor.execute("UPDATE isp_radius_nas SET nasname = %s WHERE router_id = %s", (nasname, router["id"]))
        return None
    secret = secrets.token_urlsafe(18)
    sealed = routeros_api.seal_password(secret)
    cursor.execute(
        "INSERT INTO isp_radius_nas (router_id, nasname, secret_sealed) VALUES (%s, %s, %s)",
        (router["id"], nasname, sealed),
    )
    cursor.execute(
        """
        INSERT INTO nas (nasname, shortname, type, secret, description)
        VALUES (%s, %s, 'mikrotik', %s, %s)
        ON DUPLICATE KEY UPDATE secret = VALUES(secret), description = VALUES(description)
        """,
        (nasname, str(router.get("name") or "")[:32], secret, router["id"]),
    )
    return secret


def send_disconnect(host, secret, username, session_id="", framed=""):
    if not host or not secret:
        return "queued"
    identifier = secrets.randbelow(256)
    user = username.encode()
    attributes = bytes([1, len(user) + 2]) + user
    if session_id:
        sid = session_id.encode()
        attributes += bytes([44, len(sid) + 2]) + sid
    if framed:
        try:
            attributes += bytes([8, 6]) + socket.inet_aton(framed)
        except OSError:
            pass
    length = 20 + len(attributes)
    head = bytes([40, identifier, length >> 8, length & 255])
    authenticator = hashlib.md5(head + bytes(16) + attributes + secret.encode()).digest()
    packet = head + authenticator + attributes
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(2)
        sock.sendto(packet, (host, 3799))
        try:
            data, _source = sock.recvfrom(4096)
            if data and data[0] == 41:
                return "sent"
            if data and data[0] == 42:
                return "refused"
        except socket.timeout:
            return "no-answer"
        finally:
            sock.close()
    except OSError:
        return "queued"


def log_event(cursor, client_id, subscriber_id, actor_id, action, reason=""):
    cursor.execute(
        """
        INSERT INTO pppoe_events (id, client_id, subscriber_id, actor_id, action, reason)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (str(uuid.uuid4()), client_id, subscriber_id, actor_id, action, reason[:160]),
    )


def load_router(cursor, client_id, router_id):
    cursor.execute(
        """
        SELECT id, name, site, status, tunnel_status, tunnel_ip, ip_pool_start, ip_pool_end, pppoe_interface
        FROM isp_mikrotik_devices
        WHERE id = %s AND client_id = %s
        """,
        (router_id, client_id),
    )
    row = cursor.fetchone()
    if not row:
        return None
    return {
        "id": row["id"],
        "name": row["name"],
        "site": row["site"],
        "status": row["status"],
        "tunnelStatus": row["tunnel_status"],
        "tunnel_ip": row["tunnel_ip"],
        "poolStart": row.get("ip_pool_start"),
        "poolEnd": row.get("ip_pool_end"),
        "interface": row.get("pppoe_interface") or "",
    }


def load_package(cursor, client_id, package_id):
    cursor.execute(
        """
        SELECT id, name, price, download_mbps, upload_mbps, status, availability_routers, simultaneous_devices
        FROM isp_packages
        WHERE id = %s AND client_id = %s
        """,
        (package_id, client_id),
    )
    row = cursor.fetchone()
    if not row:
        return None
    try:
        routers = json.loads(row["availability_routers"] or "[]")
    except json.JSONDecodeError:
        routers = []
    return {
        "id": row["id"],
        "name": row["name"],
        "price": format(Decimal(row["price"]), ".2f"),
        "downloadMbps": int(row["download_mbps"]),
        "uploadMbps": int(row["upload_mbps"]),
        "status": row["status"],
        "devices": int(row["simultaneous_devices"] or 0),
        "routers": routers if isinstance(routers, list) else [],
    }


def context_for(cursor, client_id, payload, ignore_id=None):
    cursor.execute("SELECT pppoe_username FROM pppoe_subscribers")
    names = {row["pppoe_username"] for row in cursor.fetchall()}
    cursor.execute("SELECT username FROM radcheck")
    names.update(row["username"] for row in cursor.fetchall())
    if ignore_id:
        cursor.execute("SELECT pppoe_username FROM pppoe_subscribers WHERE id = %s", (ignore_id,))
        own = cursor.fetchone()
        if own:
            names.discard(own["pppoe_username"])
    cursor.execute("SELECT router_serial FROM pppoe_subscribers WHERE router_serial IS NOT NULL AND router_serial <> ''")
    serials = {row["router_serial"] for row in cursor.fetchall()}
    cursor.execute("SELECT phone FROM pppoe_subscribers")
    phones = {row["phone"] for row in cursor.fetchall()}
    router = load_router(cursor, client_id, str(payload.get("routerId") or ""))
    package = load_package(cursor, client_id, str(payload.get("packageId") or ""))
    cursor.execute("SELECT static_ip FROM pppoe_subscribers WHERE static_ip IS NOT NULL AND static_ip <> ''")
    used = {row["static_ip"] for row in cursor.fetchall()}
    pool = None
    interfaces = None
    if router and router.get("poolStart") and router.get("poolEnd"):
        pool = {"start": router["poolStart"], "end": router["poolEnd"]}
    if router and router.get("interface"):
        interfaces = [router["interface"]]
    return {
        "usernames": names,
        "serials": serials,
        "phones": phones,
        "router": router,
        "package": package,
        "usedIps": used,
        "interfaces": interfaces,
        "pool": pool,
    }


def begin(cursor):
    cursor.connection.begin()


def finish(cursor):
    cursor.connection.commit()


def abort(cursor):
    cursor.connection.rollback()


def create_invoice(cursor, client_id, subscriber_id, amount, purpose, status, reference=None):
    invoice_id = str(uuid.uuid4())
    cursor.execute(
        """
        INSERT INTO pppoe_invoices (id, client_id, subscriber_id, amount, purpose, status, mpesa_reference)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (invoice_id, client_id, subscriber_id, amount, purpose, status, reference),
    )
    return invoice_id


def create_payment(cursor, client_id, subscriber_id, invoice_id, amount, method, reference):
    cursor.execute(
        """
        INSERT INTO pppoe_payments (id, client_id, subscriber_id, invoice_id, amount, method, mpesa_reference)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (str(uuid.uuid4()), client_id, subscriber_id, invoice_id, amount, method, reference or None),
    )


def register_subscriber(cursor, client_id, payload):
    context = context_for(cursor, client_id, payload)
    checked = pppoe_service.validate_pppoe_provisioning(payload, context)
    if checked["errors"]:
        raise PppoeError(400, checked["errors"][0]["message"], {"errors": checked["errors"], "warnings": checked["warnings"]})
    plan = checked["normalized"]
    subscriber_id = str(uuid.uuid4())
    sealed = routeros_api.seal_password(plan["password"])
    net = Decimal(plan["price"]) - Decimal(plan["discount"])
    begin(cursor)
    try:
        cursor.execute(
            """
            INSERT INTO pppoe_subscribers (
              id, client_id, first_name, last_name, phone, email, building_name, house_number,
              pppoe_username, password_sealed, router_id, package_id, router_serial, static_ip,
              session_limit, access_interface, mtu, status, start_date, created_by
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                subscriber_id,
                client_id,
                plan["firstName"],
                plan["lastName"],
                plan["phone"],
                plan["email"],
                plan["buildingName"],
                plan["houseNumber"],
                plan["username"],
                sealed,
                plan["routerId"],
                plan["packageId"],
                plan["serial"] or None,
                plan["staticIp"],
                plan["sessionLimit"],
                plan["accessInterface"],
                plan["mtu"],
                plan["status"],
                plan["startDate"],
                client_id,
            ),
        )
        billing = "paid" if Decimal(plan["initialPayment"]) >= net and net > 0 else "pending"
        cursor.execute(
            """
            INSERT INTO pppoe_subscriptions (
              id, subscriber_id, package_id, price, billing_cycle, cycle_days, start_date,
              next_due_date, expiry_date, grace_days, auto_renew, billing_status, discount, discount_reason
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                str(uuid.uuid4()),
                subscriber_id,
                plan["packageId"],
                plan["price"],
                plan["billingCycle"],
                plan["cycleDays"],
                plan["startDate"],
                plan["nextDueDate"],
                plan["expiryDate"],
                plan["graceDays"],
                1 if plan["autoRenew"] else 0,
                billing,
                plan["discount"],
                plan["discountReason"],
            ),
        )
        if net > 0:
            invoice_status = "paid" if Decimal(plan["initialPayment"]) >= net else "pending"
            invoice_id = create_invoice(cursor, client_id, subscriber_id, format(net, ".2f"), "subscription", invoice_status)
            if Decimal(plan["initialPayment"]) > 0:
                create_payment(cursor, client_id, subscriber_id, invoice_id, plan["initialPayment"], "manual", payload.get("mpesaReference"))
        write_radius(
            cursor,
            plan["username"],
            {
                **plan,
                "sessionLimit": effective_session_limit(plan["sessionLimit"], (context.get("package") or {}).get("devices")),
            },
        )
        issued = ensure_nas(cursor, context["router"])
        log_event(cursor, client_id, subscriber_id, client_id, "register", plan["status"])
        finish(cursor)
    except PppoeError:
        abort(cursor)
        raise
    except Exception as error:
        abort(cursor)
        reason = str(error)
        if plan["password"] and plan["password"] in reason:
            reason = "The PPPoE client could not be saved. Nothing was provisioned."
        raise PppoeError(400, reason or "The PPPoE client could not be saved. Nothing was provisioned.") from error
    body = subscriber_detail(cursor, client_id, subscriber_id)
    body["warnings"] = checked["warnings"]
    body["password"] = plan["password"]
    if issued:
        body["radiusSecret"] = issued
    return body


def list_routers(cursor, client_id):
    cursor.execute(
        """
        SELECT id, name, site, status, tunnel_status
        FROM isp_mikrotik_devices
        WHERE client_id = %s AND status = 'active'
        ORDER BY name
        """,
        (client_id,),
    )
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "site": row["site"],
            "status": row["status"],
            "tunnelStatus": row["tunnel_status"],
        }
        for row in cursor.fetchall()
    ]


def packages_for_router(cursor, client_id, router_id):
    if not load_router(cursor, client_id, router_id):
        raise PppoeError(404, "That router was not found.")
    cursor.execute(
        """
        SELECT id, name, price, download_mbps, upload_mbps, status, availability_routers
        FROM isp_packages
        WHERE client_id = %s AND status = 'active'
        ORDER BY name
        """,
        (client_id,),
    )
    packages = []
    for row in cursor.fetchall():
        package = load_package(cursor, client_id, row["id"])
        if package and router_id in {str(item) for item in package["routers"]}:
            packages.append(
                {
                    "id": package["id"],
                    "name": package["name"],
                    "price": package["price"],
                    "downloadMbps": package["downloadMbps"],
                    "uploadMbps": package["uploadMbps"],
                }
            )
    return packages


def check_username(cursor, client_id, username):
    if not allow_username_check(client_id):
        raise PppoeError(429, "Too many username checks. Wait a moment and try again.")
    text = str(username or "").strip()
    candidates = {text.lower()} | {alias.lower() for alias in pppoe_service.phone_variants(text)}
    marks = ", ".join(["%s"] * len(candidates))
    cursor.execute(f"SELECT id FROM pppoe_subscribers WHERE LOWER(pppoe_username) IN ({marks})", list(candidates))
    taken = cursor.fetchone() is not None
    if not taken:
        cursor.execute(f"SELECT id FROM radcheck WHERE LOWER(username) IN ({marks})", list(candidates))
        taken = cursor.fetchone() is not None
    return {"username": text, "available": not taken}


def public_row(row):
    return {
        "id": row["id"],
        "firstName": row["first_name"],
        "lastName": row["last_name"],
        "phone": row["phone"],
        "email": row["email"],
        "username": row["pppoe_username"],
        "routerId": row["router_id"],
        "routerName": row.get("router_name") or "",
        "packageId": row["package_id"],
        "packageName": row.get("package_name") or "",
        "serial": row.get("router_serial") or "",
        "status": row["status"],
        "connection": pppoe_service.connection_label(
            int(row.get("open_sessions") or 0),
            int(row.get("any_sessions") or 0) > 0,
            row.get("tunnel_status") or "unknown",
        ),
        "routerStatus": pppoe_service.router_status(
            row["status"],
            row.get("open_sessions") or 0,
            as_day(row.get("expiry_date")),
            date.today(),
            row.get("last_action") or "",
            row.get("tunnel_status") or "unknown",
        ),
        "billingStatus": row.get("billing_status") or "pending",
        "expiry": stamp(row.get("expiry_date")),
        "price": format(Decimal(row["price"]), ".2f") if row.get("price") is not None else None,
        "downloadMbps": None if row.get("download_mbps") is None else int(row["download_mbps"]),
        "uploadMbps": None if row.get("upload_mbps") is None else int(row["upload_mbps"]),
    }


def list_subscribers(cursor, client_id, query, service="pppoe"):
    reconcile(cursor, client_id)
    where = ["s.client_id = %s", "s.service = %s"]
    args = [client_id, service]
    router = (query.get("router") or [""])[0]
    package = (query.get("package") or [""])[0]
    status = (query.get("status") or [""])[0]
    billing = (query.get("billing") or [""])[0]
    search = (query.get("q") or [""])[0].strip()
    if router:
        where.append("s.router_id = %s")
        args.append(router)
    if package:
        where.append("s.package_id = %s")
        args.append(package)
    router_states = {"surfing", "not_surfing", "expired", "expired_online", "suspended", "suspended_online", "disconnecting", "disconnected", "pending_activation"}
    if status in router_states or status in {"online", "offline", "unknown"}:
        pass
    elif status:
        where.append("s.status = %s")
        args.append(status)
    if billing:
        where.append("sub.billing_status = %s")
        args.append(billing)
    if search:
        where.append("(s.first_name LIKE %s OR s.last_name LIKE %s OR s.phone LIKE %s OR s.pppoe_username LIKE %s OR s.router_serial LIKE %s)")
        like = f"%{search}%"
        args.extend([like, like, like, like, like])
    try:
        limit = min(1000, max(1, int((query.get("limit") or ["1000"])[0])))
        offset = max(0, int((query.get("offset") or ["0"])[0]))
    except ValueError as error:
        raise PppoeError(400, "Enter a valid page size.") from error
    sql = f"""
        SELECT s.*, sub.billing_status, sub.expiry_date, sub.price, sub.next_due_date,
               p.name AS package_name, p.download_mbps, p.upload_mbps,
               d.name AS router_name, d.tunnel_status,
               (SELECT COUNT(*) FROM radacct a WHERE a.username = s.pppoe_username AND a.acctstoptime IS NULL) AS open_sessions,
               (SELECT COUNT(*) FROM radacct a WHERE a.username = s.pppoe_username) AS any_sessions,
               (SELECT e.action FROM pppoe_events e WHERE e.subscriber_id = s.id ORDER BY e.created_at DESC LIMIT 1) AS last_action
        FROM pppoe_subscribers s
        JOIN pppoe_subscriptions sub ON sub.subscriber_id = s.id
        JOIN isp_packages p ON p.id = s.package_id
        LEFT JOIN isp_mikrotik_devices d ON d.id = s.router_id
        WHERE {' AND '.join(where)}
        ORDER BY s.first_name, s.last_name
    """
    cursor.execute(sql, args)
    rows = [public_row(row) for row in cursor.fetchall()]
    if status in router_states:
        wanted = {"expired", "expired_online"} if status == "expired" else {"suspended", "suspended_online"} if status == "suspended" else {status}
        rows = [row for row in rows if row["routerStatus"] in wanted]
    elif status in {"online", "offline", "unknown"}:
        rows = [row for row in rows if row["connection"] == status]
    total = len(rows)
    return {
        "subscribers": rows[offset:offset + limit],
        "total": total,
        "limit": limit,
        "offset": offset,
        "routers": list_routers(cursor, client_id),
        "packages": [
            {"id": item["id"], "name": item["name"]}
            for item in cursor_packages(cursor, client_id)
        ],
    }


def cursor_packages(cursor, client_id):
    cursor.execute(
        "SELECT id, name FROM isp_packages WHERE client_id = %s ORDER BY name",
        (client_id,),
    )
    return [{"id": row["id"], "name": row["name"]} for row in cursor.fetchall()]


def require_owned(cursor, client_id, subscriber_id):
    cursor.execute(
        """
        SELECT s.*, sub.billing_status, sub.expiry_date, sub.price, sub.next_due_date, sub.billing_cycle,
               sub.cycle_days, sub.grace_days, sub.auto_renew, sub.discount, sub.discount_reason, sub.start_date AS sub_start,
               p.name AS package_name, p.download_mbps, p.upload_mbps, p.simultaneous_devices AS package_devices,
               d.name AS router_name, d.tunnel_status, d.tunnel_ip, d.api_secret,
               (SELECT e.action FROM pppoe_events e WHERE e.subscriber_id = s.id ORDER BY e.created_at DESC LIMIT 1) AS last_action
        FROM pppoe_subscribers s
        JOIN pppoe_subscriptions sub ON sub.subscriber_id = s.id
        JOIN isp_packages p ON p.id = s.package_id
        LEFT JOIN isp_mikrotik_devices d ON d.id = s.router_id
        WHERE s.id = %s AND s.client_id = %s
        """,
        (subscriber_id, client_id),
    )
    row = cursor.fetchone()
    if not row:
        raise PppoeError(404, "That PPPoE client was not found.")
    cursor.execute(
        "SELECT COUNT(*) AS open_sessions FROM radacct WHERE username = %s AND acctstoptime IS NULL",
        (row["pppoe_username"],),
    )
    row["open_sessions"] = cursor.fetchone()["open_sessions"]
    cursor.execute("SELECT COUNT(*) AS any_sessions FROM radacct WHERE username = %s", (row["pppoe_username"],))
    row["any_sessions"] = cursor.fetchone()["any_sessions"]
    return row


def subscriber_detail(cursor, client_id, subscriber_id):
    row = require_owned(cursor, client_id, subscriber_id)
    body = public_row(row)
    body.update(
        {
            "buildingName": row["building_name"],
            "houseNumber": row["house_number"],
            "staticIp": row["static_ip"] or "",
            "sessionLimit": int(row["session_limit"]),
            "accessInterface": row["access_interface"],
            "mtu": int(row["mtu"]),
            "startDate": stamp(row["start_date"]),
            "nextDueDate": stamp(row["next_due_date"]),
            "graceDays": int(row["grace_days"]),
            "autoRenew": bool(row["auto_renew"]),
            "discount": format(Decimal(row["discount"]), ".2f"),
            "discountReason": row["discount_reason"],
            "billingCycle": row["billing_cycle"],
            "rateLimit": f"{int(row['upload_mbps'])}M/{int(row['download_mbps'])}M",
        }
    )
    body["billing"] = billing_block(cursor, subscriber_id, row)
    body["usage"] = usage_block(cursor, row["pppoe_username"])
    body["sessions"] = session_rows(cursor, row["pppoe_username"], 10, 0)["sessions"]
    body["events"] = event_rows(cursor, subscriber_id)
    current = current_session(cursor, row["pppoe_username"])
    body["live"] = {
        "connection": body["connection"],
        "ip": (current or {}).get("ip") or row["static_ip"] or "",
        "mac": (current or {}).get("mac") or "",
        "uptime": (current or {}).get("uptime") or "",
        "router": row["router_name"],
        "lastSeen": (current or {}).get("lastSeen"),
        "rates": live_rates(cursor, row) if body["connection"] == "online" else None,
    }
    body["devices"] = device_rows(cursor, row)
    return body


def current_session(cursor, username):
    cursor.execute(
        """
        SELECT framedipaddress, callingstationid, acctstarttime, acctupdatetime, acctinputoctets, acctoutputoctets
        FROM radacct
        WHERE username = %s AND acctstoptime IS NULL
        ORDER BY acctstarttime DESC
        LIMIT 1
        """,
        (username,),
    )
    row = cursor.fetchone()
    if not row:
        cursor.execute(
            """
            SELECT framedipaddress, callingstationid, acctstoptime
            FROM radacct WHERE username = %s ORDER BY COALESCE(acctstoptime, acctstarttime) DESC LIMIT 1
            """,
            (username,),
        )
        last = cursor.fetchone()
        if not last:
            return None
        return {"ip": last.get("framedipaddress") or "", "mac": last.get("callingstationid") or "", "uptime": "", "lastSeen": stamp(last.get("acctstoptime"))}
    started = row.get("acctstarttime")
    uptime = ""
    if isinstance(started, datetime):
        uptime = str(datetime.now() - started).split(".", 1)[0]
    return {
        "ip": row.get("framedipaddress") or "",
        "mac": row.get("callingstationid") or "",
        "uptime": uptime,
        "lastSeen": stamp(row.get("acctupdatetime") or row.get("acctstarttime")),
        "bytesIn": int(row.get("acctinputoctets") or 0),
        "bytesOut": int(row.get("acctoutputoctets") or 0),
    }


def session_device(cursor, row):
    """(host, api_secret) for the NAS actually holding the open session.

    Falls back to the assigned router when there is no live session — the
    subscriber's router_id can point at a deleted device.
    """
    host = row.get("tunnel_ip")
    secret = row.get("api_secret")
    username = row.get("pppoe_username")
    if not username:
        return host, secret
    cursor.execute(
        "SELECT nasipaddress FROM radacct WHERE username = %s AND acctstoptime IS NULL LIMIT 1",
        (username,),
    )
    session = cursor.fetchone()
    if session and session.get("nasipaddress"):
        cursor.execute(
            "SELECT tunnel_ip, api_secret FROM isp_mikrotik_devices WHERE tunnel_ip = %s LIMIT 1",
            (session["nasipaddress"],),
        )
        device = cursor.fetchone()
        if device and device.get("api_secret"):
            host, secret = device["tunnel_ip"], device["api_secret"]
    return host, secret


def live_rates(cursor, row):
    """Best-effort instantaneous throughput for the subscriber's dynamic PPPoE interface."""
    username = row.get("pppoe_username")
    if not username:
        return None
    host, secret = session_device(cursor, row)
    if not host or not secret:
        return None
    try:
        return routeros_api.subscriber_rates(host, routeros_api.open_password(secret), username)
    except Exception:
        return None


def device_rows(cursor, row):
    """Per-device view of a subscriber's sessions, keyed by the dialing MAC.

    Live sessions come straight from the NAS (real uptime + byte counters);
    radacct provides per-device history and lifetime totals. When the router
    is reachable it is the authority on which devices are online — a stale
    open radacct row is not enough to mark a device connected.
    """
    username = row.get("pppoe_username") or ""
    devices = []
    if not username:
        return devices
    cursor.execute(
        """
        SELECT callingstationid AS mac,
               COUNT(*) AS sessions,
               COALESCE(SUM(CASE WHEN acctstoptime IS NOT NULL THEN acctsessiontime ELSE 0 END), 0) AS seconds,
               COALESCE(SUM(CASE WHEN acctstoptime IS NOT NULL THEN acctinputoctets ELSE 0 END), 0) AS bytes_in,
               COALESCE(SUM(CASE WHEN acctstoptime IS NOT NULL THEN acctoutputoctets ELSE 0 END), 0) AS bytes_out,
               COALESCE(SUM(CASE WHEN acctstoptime IS NULL THEN acctsessiontime ELSE 0 END), 0) AS open_seconds,
               COALESCE(SUM(CASE WHEN acctstoptime IS NULL THEN acctinputoctets ELSE 0 END), 0) AS open_bytes_in,
               COALESCE(SUM(CASE WHEN acctstoptime IS NULL THEN acctoutputoctets ELSE 0 END), 0) AS open_bytes_out,
               MAX(COALESCE(acctstoptime, acctupdatetime, acctstarttime)) AS last_seen,
               MAX(acctstoptime IS NULL) AS is_online,
               MAX(CASE WHEN acctstoptime IS NULL THEN acctstarttime END) AS online_since,
               MAX(CASE WHEN acctstoptime IS NULL THEN framedipaddress END) AS ip
        FROM radacct
        WHERE username = %s AND callingstationid IS NOT NULL AND callingstationid <> ''
        GROUP BY callingstationid
        ORDER BY is_online DESC, last_seen DESC
        """,
        (username,),
    )
    rows = cursor.fetchall()
    live = {}
    router_seen = False
    host, secret = session_device(cursor, row)
    if host and secret:
        try:
            for session in routeros_api.live_sessions(host, routeros_api.open_password(secret), username):
                live[routeros_api.norm_mac(session["mac"])] = session
            router_seen = True
        except Exception:
            live = {}
    now = datetime.now()
    seen = set()
    for item in rows:
        mac = item.get("mac") or ""
        key = routeros_api.norm_mac(mac)
        seen.add(key)
        seconds = int(item.get("seconds") or 0)
        bytes_in = int(item.get("bytes_in") or 0)
        bytes_out = int(item.get("bytes_out") or 0)
        since = item.get("online_since")
        ip = item.get("ip") or ""
        last_seen = item.get("last_seen")
        online = False
        online_for = ""
        current = live.get(key)
        if current is not None:
            online = True
            ip = current.get("ip") or ip
            online_for = current.get("uptime") or ""
            seconds += int(current.get("seconds") or 0)
            bytes_in += int(current.get("bytesIn") or 0)
            bytes_out += int(current.get("bytesOut") or 0)
            last_seen = now
        elif not router_seen and isinstance(since, datetime):
            # Router unreachable — trust the accounting state instead.
            online = True
            online_for = str(now - since).split(".", 1)[0]
            seconds += max(int(item.get("open_seconds") or 0), int((now - since).total_seconds()))
            bytes_in += int(item.get("open_bytes_in") or 0)
            bytes_out += int(item.get("open_bytes_out") or 0)
        devices.append(
            {
                "mac": mac,
                "ip": ip,
                "sessions": int(item.get("sessions") or 0),
                "seconds": seconds,
                "bytesIn": bytes_in,
                "bytesOut": bytes_out,
                "online": online,
                "onlineFor": online_for,
                "lastSeen": stamp(last_seen),
            }
        )
    for key, current in live.items():
        if key in seen:
            continue
        devices.insert(
            0,
            {
                "mac": current.get("mac") or "",
                "ip": current.get("ip") or "",
                "sessions": 1,
                "seconds": int(current.get("seconds") or 0),
                "bytesIn": int(current.get("bytesIn") or 0),
                "bytesOut": int(current.get("bytesOut") or 0),
                "online": True,
                "onlineFor": current.get("uptime") or "",
                "lastSeen": stamp(now),
            },
        )
    return devices


def session_rows(cursor, username, limit, offset):
    cursor.execute("SELECT COUNT(*) AS total FROM radacct WHERE username = %s", (username,))
    total = int(cursor.fetchone()["total"])
    cursor.execute(
        """
        SELECT acctstarttime, acctstoptime, acctsessiontime, framedipaddress, callingstationid,
               acctinputoctets, acctoutputoctets, acctterminatecause
        FROM radacct
        WHERE username = %s
        ORDER BY acctstarttime DESC
        LIMIT %s OFFSET %s
        """,
        (username, limit, offset),
    )
    sessions = []
    for row in cursor.fetchall():
        sessions.append(
            {
                "login": stamp(row["acctstarttime"]),
                "logout": stamp(row["acctstoptime"]),
                "duration": int(row["acctsessiontime"] or 0),
                "ip": row["framedipaddress"] or "",
                "mac": row["callingstationid"] or "",
                "bytesIn": int(row["acctinputoctets"] or 0),
                "bytesOut": int(row["acctoutputoctets"] or 0),
                "cause": row["acctterminatecause"] or "",
            }
        )
    return {"sessions": sessions, "total": total, "limit": limit, "offset": offset}


def general_usage(cursor, client_id, service):
    cursor.execute(
        """
        SELECT s.id, s.first_name, s.last_name, s.pppoe_username, d.name AS router_name,
               COALESCE(SUM(CASE WHEN a.acctstarttime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN a.acctinputoctets ELSE 0 END), 0) AS month_in,
               COALESCE(SUM(CASE WHEN a.acctstarttime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN a.acctoutputoctets ELSE 0 END), 0) AS month_out
        FROM pppoe_subscribers s
        LEFT JOIN isp_mikrotik_devices d ON d.id = s.router_id
        LEFT JOIN radacct a ON a.username = s.pppoe_username
        WHERE s.client_id = %s AND s.service = %s
        GROUP BY s.id, s.first_name, s.last_name, s.pppoe_username, d.name
        ORDER BY (month_in + month_out) DESC, s.first_name, s.last_name
        """,
        (client_id, service),
    )
    clients = []
    month_in = 0
    month_out = 0
    for row in cursor.fetchall():
        download = int(row["month_in"] or 0)
        upload = int(row["month_out"] or 0)
        month_in += download
        month_out += upload
        clients.append(
            {
                "id": row["id"],
                "firstName": row["first_name"],
                "lastName": row["last_name"],
                "username": row["pppoe_username"],
                "routerName": row["router_name"],
                "bytesIn": download,
                "bytesOut": upload,
            }
        )
    cursor.execute(
        """
        SELECT DATE(a.acctstarttime) AS day, COALESCE(SUM(a.acctinputoctets), 0) AS bytes_in,
               COALESCE(SUM(a.acctoutputoctets), 0) AS bytes_out
        FROM radacct a
        JOIN pppoe_subscribers s ON s.pppoe_username = a.username
        WHERE s.client_id = %s AND s.service = %s AND a.acctstarttime >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
        GROUP BY DATE(a.acctstarttime)
        ORDER BY day
        """,
        (client_id, service),
    )
    days = [
        {"day": stamp(row["day"]), "bytesIn": int(row["bytes_in"]), "bytesOut": int(row["bytes_out"])}
        for row in cursor.fetchall()
    ]
    return {
        "service": service,
        "clients": clients,
        "total": len(clients),
        "monthBytesIn": month_in,
        "monthBytesOut": month_out,
        "days": days,
    }


def usage_block(cursor, username):
    cursor.execute(
        """
        SELECT DATE(acctstarttime) AS day, COALESCE(SUM(acctinputoctets), 0) AS bytes_in,
               COALESCE(SUM(acctoutputoctets), 0) AS bytes_out
        FROM radacct
        WHERE username = %s AND acctstarttime >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
        GROUP BY DATE(acctstarttime)
        ORDER BY day
        """,
        (username,),
    )
    days = [
        {"day": stamp(row["day"]), "bytesIn": int(row["bytes_in"]), "bytesOut": int(row["bytes_out"])}
        for row in cursor.fetchall()
    ]
    cursor.execute(
        """
        SELECT COALESCE(SUM(acctinputoctets), 0) AS bytes_in, COALESCE(SUM(acctoutputoctets), 0) AS bytes_out
        FROM radacct
        WHERE username = %s AND acctstarttime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        """,
        (username,),
    )
    month = cursor.fetchone()
    return {"days": days, "monthBytesIn": int(month["bytes_in"]), "monthBytesOut": int(month["bytes_out"])}


def usage_trend(cursor, username, scale="hours"):
    since = routeros_api.trend_since(scale, datetime.now())
    cursor.execute(
        """
        SELECT acctstarttime AS started, acctstoptime AS ended
        FROM radacct
        WHERE username = %s AND (acctstoptime IS NULL OR acctstoptime >= %s)
        """,
        (username, since),
    )
    spans = [(row["started"], row["ended"]) for row in cursor.fetchall()]
    return routeros_api.trend_series(spans, scale=scale)


def billing_block(cursor, subscriber_id, row):
    cursor.execute(
        """
        SELECT id, amount, purpose, status, mpesa_reference, created_at
        FROM pppoe_invoices WHERE subscriber_id = %s ORDER BY created_at DESC
        """,
        (subscriber_id,),
    )
    invoices = [
        {
            "id": item["id"],
            "amount": format(Decimal(item["amount"]), ".2f"),
            "purpose": item["purpose"],
            "status": item["status"],
            "reference": item["mpesa_reference"] or "",
            "createdAt": stamp(item["created_at"]),
        }
        for item in cursor.fetchall()
    ]
    cursor.execute(
        """
        SELECT id, amount, method, mpesa_reference, created_at
        FROM pppoe_payments WHERE subscriber_id = %s ORDER BY created_at DESC
        """,
        (subscriber_id,),
    )
    payments = [
        {
            "id": item["id"],
            "amount": format(Decimal(item["amount"]), ".2f"),
            "method": item["method"],
            "reference": item["mpesa_reference"] or "",
            "createdAt": stamp(item["created_at"]),
        }
        for item in cursor.fetchall()
    ]
    outstanding = sum(Decimal(item["amount"]) for item in invoices if item["status"] == "pending")
    return {
        "invoices": invoices,
        "payments": payments,
        "outstanding": format(outstanding, ".2f"),
        "nextDueDate": stamp(row.get("next_due_date")),
        "expiry": stamp(row.get("expiry_date")),
        "billingStatus": row.get("billing_status"),
        "price": format(Decimal(row.get("price") or 0), ".2f"),
        "billingCycle": row.get("billing_cycle") or "monthly",
        "cycleDays": int(row.get("cycle_days") or 30),
        "graceDays": int(row.get("grace_days") or 0),
    }


def event_rows(cursor, subscriber_id):
    cursor.execute(
        """
        SELECT action, reason, created_at FROM pppoe_events
        WHERE subscriber_id = %s ORDER BY created_at DESC LIMIT 50
        """,
        (subscriber_id,),
    )
    return [{"action": row["action"], "reason": row["reason"], "at": stamp(row["created_at"])} for row in cursor.fetchall()]


UNLIMITED_SESSIONS = 255


def effective_session_limit(session_limit, package_devices):
    """How many sessions may stay open. A package device count above zero can
    only widen the per-subscriber limit, never take back sessions an admin
    already granted; zero on the package means unlimited."""
    devices = int(package_devices or 0)
    if devices <= 0:
        return UNLIMITED_SESSIONS
    return max(int(session_limit or 1), devices)


def plan_from_saved(row, active):
    password = routeros_api.open_password(row["password_sealed"])
    return {
        "password": password,
        "status": row["status"],
        "sessionLimit": effective_session_limit(row["session_limit"], row.get("package_devices")),
        "radiusActive": active,
        "expiryDate": stamp(row.get("expiry_date")),
        "staticIp": row["static_ip"] or None,
        "poolName": None if row["static_ip"] else "pppoe-pool",
        "rateLimit": f"{int(row['upload_mbps'])}M/{int(row['download_mbps'])}M",
        "groupName": f"pppoe-{row['package_id']}" if active else pppoe_service.RESTRICTED_GROUP,
    }


def subscription_can_surf(row, today):
    """A dialed session can use the internet only while the subscription is still active."""
    expiry = as_day(row.get("expiry_date"))
    if row.get("status") != "active":
        return False
    if row.get("billing_status") in ("suspended", "cancelled"):
        return False
    if expiry and today > expiry:
        return False
    return True


def sync_router_access(cursor, client_id, router_id):
    """Refresh RADIUS so only current subscriptions are allowed to dial and surf."""
    today = date.today()
    cursor.execute(
        """
        SELECT s.id, s.status, s.password_sealed, s.pppoe_username, s.package_id, s.session_limit,
               s.static_ip, sub.expiry_date, sub.billing_status, p.download_mbps, p.upload_mbps,
               p.simultaneous_devices AS package_devices
        FROM pppoe_subscribers s
        JOIN pppoe_subscriptions sub ON sub.subscriber_id = s.id
        JOIN isp_packages p ON p.id = s.package_id
        WHERE s.client_id = %s AND s.router_id = %s
        """,
        (client_id, router_id),
    )
    for row in cursor.fetchall():
        apply_plan(cursor, row, subscription_can_surf(row, today))


def apply_plan(cursor, row, active):
    plan = plan_from_saved(row, active)
    write_radius(cursor, row["pppoe_username"], plan)
    return plan


def coa_for(cursor, row, username):
    """Disconnect-Request to the NAS that actually holds the session.

    radacct.nasipaddress is where the PPPoE session really lives; a subscriber's
    router_id can be stale (deleted/ migrated router) and sending the DM there
    silently drops nothing. Falls back to the assigned router when no session is
    open, so the next dial still starts clean.
    """
    cursor.execute(
        """
        SELECT nasipaddress, acctsessionid, framedipaddress
        FROM radacct WHERE username = %s AND acctstoptime IS NULL
        """,
        (username,),
    )
    sessions = cursor.fetchall()
    if sessions:
        result = "queued"
        for session in sessions:
            host = (session.get("nasipaddress") or "").strip()
            if not host:
                continue
            cursor.execute("SELECT secret FROM nas WHERE nasname = %s LIMIT 1", (host,))
            nas = cursor.fetchone()
            if not nas or not nas.get("secret"):
                continue
            outcome = send_disconnect(
                host,
                nas["secret"],
                username,
                session.get("acctsessionid") or "",
                session.get("framedipaddress") or "",
            )
            if outcome != "queued":
                result = outcome
        return result
    cursor.execute("SELECT secret_sealed, nasname FROM isp_radius_nas WHERE router_id = %s", (row["router_id"],))
    nas = cursor.fetchone()
    if not nas:
        return "queued"
    try:
        secret = routeros_api.open_password(nas["secret_sealed"])
    except routeros_api.RouterError:
        return "queued"
    return send_disconnect(nas["nasname"], secret, username)


def disconnect_router_clients(cursor, client_id, router_id, actor_id, reason):
    """Disconnect every client still assigned to a router that is being deleted."""
    cursor.execute(
        """
        SELECT s.id, s.status, s.password_sealed, s.pppoe_username, s.package_id, s.session_limit,
               s.static_ip, s.router_id, sub.expiry_date, p.download_mbps, p.upload_mbps,
               p.simultaneous_devices AS package_devices
        FROM pppoe_subscribers s
        JOIN pppoe_subscriptions sub ON sub.subscriber_id = s.id
        JOIN isp_packages p ON p.id = s.package_id
        WHERE s.client_id = %s AND s.router_id = %s
        """,
        (client_id, router_id),
    )
    count = 0
    for row in cursor.fetchall():
        try:
            apply_plan(cursor, row, False)
        except routeros_api.RouterError:
            pass
        cursor.execute("UPDATE pppoe_subscribers SET status = 'disconnected' WHERE id = %s", (row["id"],))
        cursor.execute(
            "UPDATE pppoe_subscriptions SET billing_status = 'cancelled' WHERE subscriber_id = %s",
            (row["id"],),
        )
        log_event(cursor, client_id, row["id"], actor_id, "disconnected", reason)
        coa_for(cursor, row, row["pppoe_username"])
        count += 1
    return count


def reconcile(cursor, client_id):
    today = date.today()
    cursor.execute(
        """
        SELECT s.id, s.status, s.start_date, s.password_sealed, s.pppoe_username, s.package_id, s.session_limit,
               s.static_ip, s.router_id, sub.expiry_date, sub.billing_status, sub.next_due_date,
               p.download_mbps, p.upload_mbps, p.simultaneous_devices AS package_devices
        FROM pppoe_subscribers s
        JOIN pppoe_subscriptions sub ON sub.subscriber_id = s.id
        JOIN isp_packages p ON p.id = s.package_id
        WHERE s.client_id = %s
        """,
        (client_id,),
    )
    for row in cursor.fetchall():
        due = as_day(row["next_due_date"])
        if row["billing_status"] == "pending" and due and today > due:
            cursor.execute(
                "UPDATE pppoe_subscriptions SET billing_status = 'overdue' WHERE subscriber_id = %s",
                (row["id"],),
            )
            row["billing_status"] = "overdue"
        nxt = pppoe_service.job_transition(row["status"], as_day(row["start_date"]), as_day(row["expiry_date"]), today)
        if nxt:
            cursor.execute("UPDATE pppoe_subscribers SET status = %s WHERE id = %s", (nxt, row["id"]))
            row["status"] = nxt
            if nxt == "expired":
                cursor.execute(
                    "UPDATE pppoe_subscriptions SET billing_status = 'suspended' WHERE subscriber_id = %s AND billing_status <> 'cancelled'",
                    (row["id"],),
                )
                if row["billing_status"] != "cancelled":
                    row["billing_status"] = "suspended"
            log_event(cursor, client_id, row["id"], client_id, nxt, "Scheduled from the start or expiry date.")
        can_surf = subscription_can_surf(row, today)
        try:
            apply_plan(cursor, row, can_surf)
        except routeros_api.RouterError:
            continue
        kick = nxt is not None
        if not kick and not can_surf:
            cursor.execute(
                "SELECT COUNT(*) AS open_sessions FROM radacct WHERE username = %s AND acctstoptime IS NULL",
                (row["pppoe_username"],),
            )
            kick = int(cursor.fetchone()["open_sessions"] or 0) > 0
        if kick:
            coa_for(cursor, row, row["pppoe_username"])


def reconcile_all(connect):
    """Run the activation/expiry sweep for every client that has subscribers."""
    db = connect()
    try:
        with db.cursor() as cursor:
            cursor.execute("SELECT DISTINCT client_id FROM pppoe_subscribers")
            client_ids = [row["client_id"] for row in cursor.fetchall()]
        for client_id in client_ids:
            try:
                with db.cursor() as cursor:
                    reconcile(cursor, client_id)
            except Exception as error:
                print(f"event=pppoe-reconcile client={client_id} error={error}", flush=True)
    finally:
        db.close()


def set_status(cursor, client_id, subscriber_id, status, billing, reason, active):
    row = require_owned(cursor, client_id, subscriber_id)
    begin(cursor)
    try:
        apply_plan(cursor, row, active)
        cursor.execute("UPDATE pppoe_subscribers SET status = %s WHERE id = %s", (status, subscriber_id))
        if billing:
            cursor.execute(
                "UPDATE pppoe_subscriptions SET billing_status = %s WHERE subscriber_id = %s",
                (billing, subscriber_id),
            )
        log_event(cursor, client_id, subscriber_id, client_id, status, reason)
        finish(cursor)
    except Exception as error:
        abort(cursor)
        raise PppoeError(400, "The RADIUS update failed, so the client was left unchanged.") from error
    coa = coa_for(cursor, row, row["pppoe_username"])
    body = subscriber_detail(cursor, client_id, subscriber_id)
    body["coa"] = coa
    return body


def renew(cursor, client_id, subscriber_id, payload):
    row = require_owned(cursor, client_id, subscriber_id)
    amount = pppoe_service.money(payload.get("amount") or "0", "amount")
    if amount is None or amount <= 0:
        raise PppoeError(400, "Enter the verified payment amount before renewal.")
    reference = str(payload.get("mpesaReference") or "").strip()[:40]
    price = Decimal(row["price"] or 0)
    period = int(row["cycle_days"] or 30)
    if price <= 0 or period <= 0:
        raise PppoeError(400, "This subscription has no package price to bill against.")
    days = int(amount * period / price)
    if days < 1:
        raise PppoeError(400, "That amount buys less than a day of service on this package.")
    anchor = as_day(row["expiry_date"])
    today = date.today()
    if anchor is None or anchor < today:
        anchor = today
    due = anchor + timedelta(days=days)
    expiry = due + timedelta(days=int(row["grace_days"] or 0))
    begin(cursor)
    try:
        invoice_id = create_invoice(cursor, client_id, subscriber_id, format(amount, ".2f"), "renewal", "paid", reference)
        create_payment(cursor, client_id, subscriber_id, invoice_id, format(amount, ".2f"), "manual", reference)
        cursor.execute(
            """
            UPDATE pppoe_subscriptions
            SET next_due_date = %s, expiry_date = %s, billing_status = 'paid'
            WHERE subscriber_id = %s
            """,
            (due.isoformat(), expiry.isoformat(), subscriber_id),
        )
        cursor.execute("UPDATE pppoe_subscribers SET status = 'active' WHERE id = %s", (subscriber_id,))
        row["status"] = "active"
        apply_plan(cursor, row, True)
        log_event(cursor, client_id, subscriber_id, client_id, "renew", reference or "Payment recorded.")
        finish(cursor)
    except Exception as error:
        abort(cursor)
        raise PppoeError(400, "Renewal was not saved.") from error
    body = subscriber_detail(cursor, client_id, subscriber_id)
    body["coa"] = coa_for(cursor, row, row["pppoe_username"])
    body["daysPurchased"] = days
    return body


def activate(cursor, client_id, subscriber_id):
    row = require_owned(cursor, client_id, subscriber_id)
    if as_day(row["next_due_date"]) is None:
        start = as_day(row["sub_start"]) or date.today()
        due = pppoe_service.add_cycle(start, row["billing_cycle"], int(row["cycle_days"] or 30))
        expiry = due + timedelta(days=int(row["grace_days"] or 0))
        cursor.execute(
            "UPDATE pppoe_subscriptions SET start_date = %s, next_due_date = %s, expiry_date = %s WHERE subscriber_id = %s",
            (start, due, expiry, subscriber_id),
        )
        cursor.execute("UPDATE pppoe_subscribers SET start_date = %s WHERE id = %s", (start, subscriber_id))
    return set_status(cursor, client_id, subscriber_id, "active", None, "Activated.", True)


def reactivate(cursor, client_id, subscriber_id, payload):
    row = require_owned(cursor, client_id, subscriber_id)
    if not pppoe_service.can_reactivate(row["billing_status"], payload.get("override")):
        raise PppoeError(400, "Reactivation needs a paid balance, or an explicit override.")
    reason = str(payload.get("reason") or "").strip()
    if payload.get("override") and not reason:
        raise PppoeError(400, "Enter a reason for the override.")
    return set_status(cursor, client_id, subscriber_id, "active", "paid", reason or "Reactivated.", True)


def upgrade(cursor, client_id, subscriber_id, payload):
    row = require_owned(cursor, client_id, subscriber_id)
    package = load_package(cursor, client_id, str(payload.get("packageId") or ""))
    if not package or row["router_id"] not in {str(item) for item in package["routers"]}:
        raise PppoeError(400, "Choose a package linked to this router.")
    credit = Decimal("0.00")
    if payload.get("prorate"):
        credit = pppoe_service.prorate_credit(
            row["price"],
            as_day(row["next_due_date"]),
            date.today(),
            int(row["cycle_days"]),
        )
    begin(cursor)
    try:
        cursor.execute(
            "UPDATE pppoe_subscribers SET package_id = %s WHERE id = %s",
            (package["id"], subscriber_id),
        )
        cursor.execute(
            "UPDATE pppoe_subscriptions SET package_id = %s, price = %s WHERE subscriber_id = %s",
            (package["id"], package["price"], subscriber_id),
        )
        if credit > 0:
            create_invoice(cursor, client_id, subscriber_id, format(-credit, ".2f"), "prorate", "paid")
        row["package_id"] = package["id"]
        row["upload_mbps"] = package["uploadMbps"]
        row["download_mbps"] = package["downloadMbps"]
        apply_plan(cursor, row, row["status"] == "active")
        log_event(cursor, client_id, subscriber_id, client_id, "upgrade", package["name"])
        finish(cursor)
    except Exception as error:
        abort(cursor)
        raise PppoeError(400, "The package change was not saved.") from error
    body = subscriber_detail(cursor, client_id, subscriber_id)
    body["coa"] = coa_for(cursor, row, row["pppoe_username"])
    return body


def migrate(cursor, client_id, subscriber_id, payload):
    row = require_owned(cursor, client_id, subscriber_id)
    router = load_router(cursor, client_id, str(payload.get("routerId") or ""))
    if not router or router["status"] != "active":
        raise PppoeError(400, "Choose an active router.")
    package_id = str(payload.get("packageId") or row["package_id"])
    package = load_package(cursor, client_id, package_id)
    if not package or router["id"] not in {str(item) for item in package["routers"]}:
        raise PppoeError(400, "That package is not linked to the target router.")
    old_nas = row["router_id"]
    begin(cursor)
    try:
        cursor.execute(
            "UPDATE pppoe_subscribers SET router_id = %s, package_id = %s, static_ip = NULL WHERE id = %s",
            (router["id"], package["id"], subscriber_id),
        )
        cursor.execute(
            "UPDATE pppoe_subscriptions SET package_id = %s, price = %s WHERE subscriber_id = %s",
            (package["id"], package["price"], subscriber_id),
        )
        row["router_id"] = router["id"]
        row["package_id"] = package["id"]
        row["static_ip"] = None
        row["upload_mbps"] = package["uploadMbps"]
        row["download_mbps"] = package["downloadMbps"]
        apply_plan(cursor, row, row["status"] == "active")
        log_event(cursor, client_id, subscriber_id, client_id, "migrate", router["name"])
        finish(cursor)
    except Exception as error:
        abort(cursor)
        raise PppoeError(400, "The router move was not saved.") from error
    row["router_id"] = old_nas
    coa_for(cursor, row, row["pppoe_username"])
    return subscriber_detail(cursor, client_id, subscriber_id)


def disconnect(cursor, client_id, subscriber_id, payload):
    row = require_owned(cursor, client_id, subscriber_id)
    if str(payload.get("mode") or "session") == "terminate":
        reason = str(payload.get("reason") or "").strip()
        if not reason:
            raise PppoeError(400, "Enter a reason for termination.")
        body = set_status(cursor, client_id, subscriber_id, "disconnected", "cancelled", reason, False)
        return body
    open_count = int(row.get("open_sessions") or 0)
    action = pppoe_service.duplicate_session_action(
        open_count, effective_session_limit(row["session_limit"], row.get("package_devices"))
    )
    coa = coa_for(cursor, row, row["pppoe_username"])
    log_event(cursor, client_id, subscriber_id, client_id, "disconnect", action)
    body = subscriber_detail(cursor, client_id, subscriber_id)
    body["coa"] = coa
    body["sessionPolicy"] = action
    return body


def reset_password(cursor, client_id, subscriber_id, payload):
    row = require_owned(cursor, client_id, subscriber_id)
    password = str(payload.get("password") or "") or pppoe_service.generate_password()
    if not pppoe_service.password_ok(password):
        raise PppoeError(400, "Use 8 to 12 characters without O or l. A phone number like 0723864156 works.")
    begin(cursor)
    try:
        sealed = routeros_api.seal_password(password)
        cursor.execute(
            "UPDATE pppoe_subscribers SET password_sealed = %s WHERE id = %s",
            (sealed, subscriber_id),
        )
        row["password_sealed"] = sealed
        apply_plan(cursor, row, row["status"] == "active")
        log_event(cursor, client_id, subscriber_id, client_id, "password", "Password replaced.")
        finish(cursor)
    except Exception as error:
        abort(cursor)
        raise PppoeError(400, "The password was not changed.") from error
    body = subscriber_detail(cursor, client_id, subscriber_id)
    body["password"] = password
    return body


def reveal_password(cursor, client_id, subscriber_id):
    row = require_owned(cursor, client_id, subscriber_id)
    try:
        password = routeros_api.open_password(row["password_sealed"])
    except routeros_api.RouterError as error:
        raise PppoeError(400, "The saved password could not be read.") from error
    log_event(cursor, client_id, subscriber_id, client_id, "reveal", "Password shown.")
    return {"password": password}


def record_payment(cursor, client_id, subscriber_id, payload):
    require_owned(cursor, client_id, subscriber_id)
    amount = pppoe_service.money(payload.get("amount"), "amount")
    if amount is None or amount <= 0:
        raise PppoeError(400, "Enter the payment amount.")
    reference = str(payload.get("mpesaReference") or "").strip()[:40]
    method = "stk" if payload.get("method") == "stk" else "manual"
    if method == "stk":
        raise PppoeError(400, "M-Pesa STK push is not connected on this server yet. Record the payment after it arrives.")
    begin(cursor)
    try:
        invoice_id = create_invoice(cursor, client_id, subscriber_id, format(amount, ".2f"), "payment", "paid", reference)
        create_payment(cursor, client_id, subscriber_id, invoice_id, format(amount, ".2f"), method, reference)
        cursor.execute(
            "UPDATE pppoe_subscriptions SET billing_status = 'paid' WHERE subscriber_id = %s",
            (subscriber_id,),
        )
        log_event(cursor, client_id, subscriber_id, client_id, "payment", reference or method)
        finish(cursor)
    except Exception as error:
        abort(cursor)
        raise PppoeError(400, "The payment was not saved.") from error
    return subscriber_detail(cursor, client_id, subscriber_id)


def edit_subscriber(cursor, client_id, subscriber_id, payload):
    row = require_owned(cursor, client_id, subscriber_id)
    first = str(payload.get("firstName", "")).strip()
    last = str(payload.get("lastName", "")).strip()
    phone = pppoe_service.normalize_phone(payload.get("phone"))
    email = str(payload.get("email", "")).strip()
    building = str(payload.get("buildingName", "")).strip()
    house = str(payload.get("houseNumber", "")).strip()
    serial = str(payload.get("serial") or "").strip()
    if len(first) < 2 or len(last) < 2:
        raise PppoeError(400, "Enter a first and last name of at least 2 characters.")
    if not phone:
        raise PppoeError(400, "Enter a Kenyan phone number, such as 07…, 01…, or +254….")
    if email and (len(email) > 120 or "@" not in email):
        raise PppoeError(400, "Enter a valid email address, or leave it empty.")
    cursor.execute(
        "SELECT id FROM pppoe_subscribers WHERE phone = %s AND id <> %s",
        (phone, subscriber_id),
    )
    if cursor.fetchone():
        raise PppoeError(400, "That phone number is already registered.")
    if serial:
        cursor.execute(
            "SELECT id FROM pppoe_subscribers WHERE router_serial = %s AND id <> %s",
            (serial, subscriber_id),
        )
        if cursor.fetchone():
            raise PppoeError(400, "That serial number is already registered.")
    cursor.execute(
        """
        UPDATE pppoe_subscribers
        SET first_name = %s, last_name = %s, phone = %s, email = %s, building_name = %s, house_number = %s, router_serial = %s
        WHERE id = %s AND client_id = %s
        """,
        (first, last, phone, email, building, house, serial or None, subscriber_id, client_id),
    )
    log_event(cursor, client_id, subscriber_id, client_id, "edit", "Customer details updated.")
    return subscriber_detail(cursor, client_id, subscriber_id)


def sessions_export(cursor, client_id, subscriber_id, query):
    row = require_owned(cursor, client_id, subscriber_id)
    try:
        limit = min(500, max(1, int((query.get("limit") or ["50"])[0])))
        offset = max(0, int((query.get("offset") or ["0"])[0]))
    except ValueError as error:
        raise PppoeError(400, "Enter a valid page size.") from error
    page = session_rows(cursor, row["pppoe_username"], limit, offset)
    if (query.get("export") or [""])[0] == "csv":
        lines = ["login,logout,duration,ip,bytes_in,bytes_out,cause"]
        for item in page["sessions"]:
            lines.append(
                ",".join(
                    [
                        item["login"] or "",
                        item["logout"] or "",
                        str(item["duration"]),
                        item["ip"],
                        str(item["bytesIn"]),
                        str(item["bytesOut"]),
                        item["cause"].replace(",", " "),
                    ]
                )
            )
        page["csv"] = "\n".join(lines)
        page["filename"] = f"{row['pppoe_username']}-sessions.csv"
    return page


def dispatch(cursor, method, path, payload, token, query):
    if path == "/api/routers" and method == "GET":
        return {"routers": list_routers(cursor, client_id_from(cursor, token))}, None
    if path.startswith("/api/routers/") and path.endswith("/packages") and method == "GET":
        router_id = path.removeprefix("/api/routers/").removesuffix("/packages").strip("/")
        client_id = client_id_from(cursor, token)
        return {"packages": packages_for_router(cursor, client_id, router_id)}, None
    if path == "/api/hotspot/subscribers" and method == "GET":
        return list_subscribers(cursor, client_id_from(cursor, token), query, "hotspot"), None
    if path == "/api/hotspot/usage" and method == "GET":
        return general_usage(cursor, client_id_from(cursor, token), "hotspot"), None
    if not path.startswith("/api/pppoe"):
        return None
    client_id = client_id_from(cursor, token)
    if path == "/api/pppoe/check-username" and method == "GET":
        return check_username(cursor, client_id, (query.get("u") or [""])[0]), None
    if path == "/api/pppoe/validate" and method == "POST":
        checked = pppoe_service.validate_pppoe_provisioning(payload, context_for(cursor, client_id, payload))
        checked["normalized"] = None if checked["errors"] else {key: value for key, value in checked["normalized"].items() if key != "password"}
        return checked, None
    if path == "/api/pppoe/usage" and method == "GET":
        return general_usage(cursor, client_id, "pppoe"), None
    if path == "/api/pppoe/subscribers" and method == "GET":
        return list_subscribers(cursor, client_id, query, "pppoe"), None
    if path == "/api/pppoe/subscribers" and method == "POST":
        return {"subscriber": register_subscriber(cursor, client_id, payload)}, None
    if path == "/api/pppoe/jobs" and method == "POST":
        reconcile(cursor, client_id)
        return {"ok": True}, None
    prefix = "/api/pppoe/subscribers/"
    if not path.startswith(prefix):
        return None
    rest = path.removeprefix(prefix).strip("/")
    subscriber_id, _, action = rest.partition("/")
    if method == "GET" and not action:
        return {"subscriber": subscriber_detail(cursor, client_id, subscriber_id)}, None
    if method == "GET" and action == "sessions":
        return sessions_export(cursor, client_id, subscriber_id, query), None
    if method == "GET" and action == "usage":
        row = require_owned(cursor, client_id, subscriber_id)
        scale = str((query.get("range") or [""])[0])
        if scale in routeros_api.TREND_SCALES:
            return {"trend": usage_trend(cursor, row["pppoe_username"], scale)}, None
        return {"usage": usage_block(cursor, row["pppoe_username"])}, None
    if method == "GET" and action == "billing":
        row = require_owned(cursor, client_id, subscriber_id)
        return {"billing": billing_block(cursor, subscriber_id, row)}, None
    if method == "GET" and action == "status":
        row = require_owned(cursor, client_id, subscriber_id)
        live = current_session(cursor, row["pppoe_username"])
        label = pppoe_service.connection_label(int(row["open_sessions"] or 0), int(row["any_sessions"] or 0) > 0, row["tunnel_status"])
        rates = live_rates(cursor, row) if label == "online" else None
        devices = device_rows(cursor, row)
        return {"connection": label, "live": live, "status": row["status"], "billingStatus": row["billing_status"], "rates": rates, "devices": devices}, None
    if method != "POST":
        return None
    actions = {
        "renew": lambda: renew(cursor, client_id, subscriber_id, payload),
        "suspend": lambda: set_status(cursor, client_id, subscriber_id, "suspended", "suspended", str(payload.get("reason") or "Suspended."), False),
        "reactivate": lambda: reactivate(cursor, client_id, subscriber_id, payload),
        "upgrade": lambda: upgrade(cursor, client_id, subscriber_id, payload),
        "migrate": lambda: migrate(cursor, client_id, subscriber_id, payload),
        "disconnect": lambda: disconnect(cursor, client_id, subscriber_id, payload),
        "activate": lambda: activate(cursor, client_id, subscriber_id),
        "edit": lambda: edit_subscriber(cursor, client_id, subscriber_id, payload),
        "password": lambda: reset_password(cursor, client_id, subscriber_id, payload),
        "reveal": lambda: reveal_password(cursor, client_id, subscriber_id),
        "payment": lambda: record_payment(cursor, client_id, subscriber_id, payload),
    }
    if action not in actions:
        return None
    if action == "suspend" and not str(payload.get("reason") or "").strip():
        raise PppoeError(400, "Enter a reason for the suspension.")
    result = actions[action]()
    if action == "reveal":
        return result, None
    return {"subscriber": result}, None
