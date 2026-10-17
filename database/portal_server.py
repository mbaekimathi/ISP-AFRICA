"""Captive portal for blocked PPPoE subscribers and hotspot guests.

Blocked sessions land in the pppoe-suspended or pppoe-expired firewall
address lists. The router dst-nats their plain HTTP traffic to this
listener, which identifies the visitor through the live radacct session
and shows either a "paused" notice or a self-service recharge page with
Daraja STK push plus Paybill/Till instructions.

Captive ports (hotspot use, or the PPPoE customer port while enforcement
is off so clients get DHCP) run a RouterOS hotspot whose login page was
fetched from /hotspot-page/login.html. That page forwards the guest to
/hotspot, where they pick a hotspot package and pay through STK push; an
approved payment creates a hotspot user on the router and logs the device
in through the API.

Daraja callbacks need a public URL, which this host does not have, so the
portal polls the stkpushquery endpoint until the customer approves or
declines the prompt, then renews the subscription or opens the session
directly.
"""

import base64
import json
import os
import re
import secrets
import socket
import threading
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

import pppoe_store
import routeros_api

PORTAL_PORT = int(os.environ.get("ISP_PORTAL_PORT") or 8790)
PORTAL_HOST = os.environ.get("ISP_PORTAL_HOST") or "0.0.0.0"
STATUS = {"portal": "pending"}
DARAJA_TIMEOUT = 8
PENDING = {}
PENDING_LOCK = threading.Lock()
HOTSPOT_PENDING = {}
HOTSPOT_LOCK = threading.Lock()
VALIDITY_SECONDS = {"hours": 3600, "days": 86400, "weeks": 604800, "months": 2592000}

PAGE_CSS = """
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f4f6fb;color:#1a2233;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;max-width:420px;width:100%;box-shadow:0 8px 30px rgba(15,23,42,.08)}
h1{font-size:20px;margin-bottom:6px}
.sub{color:#64748b;font-size:13px;margin-bottom:18px}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;margin-bottom:14px}
.badge.warn{background:#fef3c7;color:#92400e}
.badge.bad{background:#fee2e2;color:#b91c1c}
.row{display:flex;justify-content:space-between;font-size:14px;padding:7px 0;border-bottom:1px solid #f1f5f9}
.row span:first-child{color:#64748b}
.row span:last-child{font-weight:600}
label{display:block;font-size:13px;font-weight:500;margin:14px 0 5px}
input{width:100%;padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:15px}
button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:10px;background:#1d4ed8;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
button:disabled{background:#94a3b8;cursor:default}
.hint{font-size:12px;color:#64748b;margin-top:10px;line-height:1.5}
.note{margin-top:16px;padding:10px 12px;background:#f1f5f9;border-radius:10px;font-size:12.5px;color:#475569;line-height:1.55}
.err{margin-top:12px;padding:10px 12px;background:#fee2e2;color:#b91c1c;border-radius:10px;font-size:13px}
.ok{margin-top:12px;padding:10px 12px;background:#dcfce7;color:#166534;border-radius:10px;font-size:13px}
"""


def page(title, body):
    return f"<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>{title}</title><style>{PAGE_CSS}</style></head><body><div class=card>{body}</div></body></html>".encode()


def esc(value):
    return str(value or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def identify(cursor, ip):
    cursor.execute(
        """
        SELECT s.id AS subscriber_id, s.client_id, s.first_name, s.last_name, s.phone,
               s.pppoe_username, s.status, p.name AS package_name, p.download_mbps, p.upload_mbps,
               sub.price, sub.billing_cycle, sub.cycle_days, sub.grace_days
        FROM radacct r
        JOIN pppoe_subscribers s ON s.pppoe_username = r.username
        JOIN pppoe_subscriptions sub ON sub.subscriber_id = s.id
        JOIN isp_packages p ON p.id = s.package_id
        WHERE r.framedipaddress = %s AND r.acctstoptime IS NULL
        ORDER BY r.acctstarttime DESC LIMIT 1
        """,
        (ip,),
    )
    return cursor.fetchone()


def normalize_phone(value):
    digits = re.sub(r"[\s\-+]", "", str(value or ""))
    if re.fullmatch(r"0[17]\d{8}", digits):
        return f"254{digits[1:]}"
    if re.fullmatch(r"254[17]\d{8}", digits):
        return digits
    return ""


def daraja_settings(cursor, client_id):
    cursor.execute(
        "SELECT scope, environment, account_type, short_code, consumer_key, consumer_secret, passkey FROM isp_payment_settings WHERE client_id = %s",
        (client_id,),
    )
    rows = {row["scope"]: row for row in cursor.fetchall()}
    for scope in ("own", "company"):
        row = rows.get(scope)
        if row and row["consumer_key"] and row["consumer_secret"]:
            return row
    return None


def daraja_host(row):
    return "https://api.safaricom.co.ke" if row["environment"] == "live" else "https://sandbox.safaricom.co.ke"


def daraja_request(row, path, payload):
    key = row["consumer_key"]
    secret = row["consumer_secret"]
    token_req = urllib.request.Request(
        f"{daraja_host(row)}/oauth/v1/generate?grant_type=client_credentials",
        headers={"Authorization": "Basic " + base64.b64encode(f"{key}:{secret}".encode()).decode()},
    )
    with urllib.request.urlopen(token_req, timeout=DARAJA_TIMEOUT) as response:
        token = json.loads(response.read().decode() or "{}").get("access_token")
    if not token:
        raise RuntimeError("Daraja did not return an access token.")
    request = urllib.request.Request(
        f"{daraja_host(row)}{path}",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=DARAJA_TIMEOUT) as response:
            return json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as error:
        try:
            body = json.loads(error.read().decode() or "{}")
        except ValueError:
            body = {}
        if body:
            return body
        raise RuntimeError(f"Daraja answered with an error ({error.code}).") from error


def stk_push(row, phone, amount, reference):
    stamp_now = datetime.now().strftime("%Y%m%d%H%M%S")
    shortcode = str(row["short_code"])
    payload = {
        "BusinessShortCode": shortcode,
        "Password": base64.b64encode(f"{shortcode}{row['passkey']}{stamp_now}".encode()).decode(),
        "Timestamp": stamp_now,
        "TransactionType": "CustomerPayBillOnline" if row["account_type"] == "paybill" else "CustomerBuyGoodsOnline",
        "Amount": int(Decimal(amount)),
        "PartyA": phone,
        "PartyB": shortcode,
        "PhoneNumber": phone,
        "CallBackURL": os.environ.get("ISP_DARAJA_CALLBACK", "https://portal.ispcentric.local/callback"),
        "AccountReference": reference,
        "TransactionDesc": "Internet recharge",
    }
    return daraja_request(row, "/mpesa/stkpush/v1/processrequest", payload)


def stk_query(row, checkout_id):
    stamp_now = datetime.now().strftime("%Y%m%d%H%M%S")
    shortcode = str(row["short_code"])
    payload = {
        "BusinessShortCode": shortcode,
        "Password": base64.b64encode(f"{shortcode}{row['passkey']}{stamp_now}".encode()).decode(),
        "Timestamp": stamp_now,
        "CheckoutRequestID": checkout_id,
    }
    return daraja_request(row, "/mpesa/stkpushquery/v1/query", payload)


def paused_page(row):
    name = esc(f"{row['first_name']} {row['last_name']}".strip()) or "Customer"
    return page(
        "Account paused",
        f"""<span class="badge warn">Paused</span>
<h1>Hi {name}, your internet is paused</h1>
<p class=sub>Your account was paused by the provider, so browsing is on hold for now.</p>
<div class=row><span>Package</span><span>{esc(row['package_name'])}</span></div>
<div class=row><span>Username</span><span>{esc(row['pppoe_username'])}</span></div>
<p class=note>If this looks wrong, contact support and quote your username above. Once the pause is lifted you will be back online automatically.</p>""",
    )


def pay_page(row, payment):
    name = esc(f"{row['first_name']} {row['last_name']}".strip()) or "Customer"
    price = Decimal(row["price"] or 0)
    cycle = int(row["cycle_days"] or 30)
    phone = esc(row["phone"])
    daily = (price / cycle).quantize(Decimal("0.01")) if cycle else Decimal("0")
    stk = ""
    if payment:
        stk = f"""
<label for=phone>M-Pesa number</label>
<input id=phone inputmode=tel value="{phone}">
<label for=amount>Amount (KSh) — {esc(str(daily))}/day on {esc(row['package_name'])}</label>
<input id=amount inputmode=decimal value="{esc(str(price))}">
<button id=paybtn onclick="pay()">Pay with M-Pesa</button>
<div id=msg></div>
<p class=hint>You'll get a prompt on the phone to approve. This page updates itself when payment lands.</p>
<script>
let cid=null;
async function poll(){{
 if(!cid)return;
 const r=await fetch('/pay/status?id='+encodeURIComponent(cid));
 const b=await r.json();
 if(b.state==='paid'){{document.getElementById('msg').innerHTML='<div class=ok>Payment received — reconnecting you now…</div>';cid=null;return;}}
 if(b.state==='failed'){{document.getElementById('msg').innerHTML='<div class=err>'+(b.reason||'Payment was not completed.')+'</div>';cid=null;document.getElementById('paybtn').disabled=false;return;}}
 setTimeout(poll,4000);
}}
async function pay(){{
 const btn=document.getElementById('paybtn');
 const r=await fetch('/pay',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{phone:document.getElementById('phone').value,amount:document.getElementById('amount').value}})}});
 const b=await r.json();
 if(b.checkoutId){{cid=b.checkoutId;btn.disabled=true;document.getElementById('msg').innerHTML='<div class=note>Check the phone and approve the M-Pesa prompt…</div>';poll();}}
 else document.getElementById('msg').innerHTML='<div class=err>'+(b.error||'Could not start the payment.')+'</div>';
}}
</script>"""
    manual = ""
    if payment:
        kind = "Paybill" if payment["account_type"] == "paybill" else "Till"
        manual = f"""<p class=note><b>Or pay manually:</b> Lipa na M-Pesa → {kind} <b>{esc(payment['short_code'])}</b> → Account <b>{esc(row['pppoe_username'])}</b>. Your line reconnects as soon as the payment is confirmed.</p>"""
    else:
        manual = "<p class=note>Online payment is not configured yet. Contact support to recharge your line.</p>"
    return page(
        "Recharge internet",
        f"""<span class="badge bad">Offline</span>
<h1>Hi {name}, your subscription needs a top-up</h1>
<p class=sub>Pay below and your internet comes back on its own — no call needed.</p>
<div class=row><span>Package</span><span>{esc(row['package_name'])}</span></div>
<div class=row><span>Speed</span><span>{int(row['download_mbps'])}↓ / {int(row['upload_mbps'])}↑ Mbps</span></div>
<div class=row><span>Price</span><span>KSh {esc(str(price))} / {cycle} days</span></div>
{stk}{manual}""",
    )


def unknown_page():
    return page(
        "Internet blocked",
        """<span class="badge warn">Blocked</span>
<h1>This connection has no active subscription</h1>
<p class=sub>We could not match this session to an account.</p>
<p class=note>Reconnect your PPPoE link, then open this page again. If it keeps showing, contact support.</p>""",
    )


HOTSPOT_CSS = """
.pick{border:1px solid #e2e8f0;border-radius:12px;padding:10px 12px;margin-bottom:8px;cursor:pointer;display:flex;gap:10px;align-items:center}
.pick input{margin:0}
.pick.on{border-color:#1d4ed8;background:#eff6ff}
.pick .nm{font-size:14px;font-weight:600}
.pick .sp{font-size:12px;color:#64748b}
.pick .pr{margin-left:auto;font-size:14px;font-weight:700;white-space:nowrap}
.okpage{text-align:center}
.creds{margin-top:14px;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;font-size:13px;text-align:left}
.creds b{font-family:ui-monospace,monospace}
"""


def portal_base():
    host = os.environ.get("ISP_PORTAL_IP") or "10.88.0.1"
    return f"http://{host}:{PORTAL_PORT}"


def router_page(name):
    """Pages fetched onto the router; $(...) tokens are filled by RouterOS."""
    if name == "login.html":
        return f"""<!doctype html><html><head><meta charset=utf-8>
<meta http-equiv="refresh" content="0; url={portal_base()}/hotspot?login=$(link-login-only)&orig=$(link-orig-esc)&ip=$(ip)&mac=$(mac-esc)">
<title>ISP CENTRIC</title></head><body style="font-family:system-ui,sans-serif;text-align:center;padding:40px">Opening the payment page…</body></html>""".encode()
    if name == "status.html":
        return """<!doctype html><html><head><meta charset=utf-8><meta http-equiv="refresh" content="3; url=$(link-orig)"><title>Connected</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f4f6fb;color:#1a2233;margin:0}.card{background:#fff;border-radius:16px;padding:28px;max-width:420px;text-align:center;box-shadow:0 8px 30px rgba(15,23,42,.08)}</style></head>
<body><div class=card><h1>You are connected</h1><p style="color:#64748b;font-size:14px">Your internet is on. Taking you back to where you were going...</p></div></body></html>""".encode()
    if name == "error.html":
        return """<!doctype html><html><head><meta charset=utf-8><title>Could not connect</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f4f6fb;color:#1a2233;margin:0}.card{background:#fff;border-radius:16px;padding:28px;max-width:420px;text-align:center;box-shadow:0 8px 30px rgba(15,23,42,.08)}</style></head>
<body><div class=card><h1>Could not connect</h1><p style="color:#b91c1c;font-size:14px">$(error)</p><p style="color:#64748b;font-size:13px">Try again, or pay again if your session ran out.</p></div></body></html>""".encode()
    return None


def json_list(value):
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return [part.strip() for part in str(value).split(",") if part.strip()]
    return [str(item) for item in parsed] if isinstance(parsed, list) else []


def hotspot_device(cursor, source_ip, requested):
    columns = "id, client_id, name, site, tunnel_ip, api_secret, status"
    cursor.execute(f"SELECT {columns} FROM isp_mikrotik_devices WHERE tunnel_ip = %s", (source_ip,))
    row = cursor.fetchone()
    if row or not requested:
        return row
    cursor.execute(f"SELECT {columns} FROM isp_mikrotik_devices WHERE id = %s", (requested,))
    return cursor.fetchone()


def hotspot_packages(cursor, client_id, device_id):
    cursor.execute(
        """
        SELECT p.id, p.name, p.price, p.download_mbps, p.upload_mbps, p.availability_routers,
               COALESCE(p.service_type, c.service_type, 'pppoe') AS service_type,
               COALESCE(p.validity_amount, c.validity_amount, 1) AS validity_amount,
               COALESCE(p.validity_unit, c.validity_unit, 'days') AS validity_unit,
               COALESCE(p.simultaneous_devices, c.simultaneous_devices, 1) AS devices
        FROM isp_packages p
        LEFT JOIN company_packages c ON c.id = p.company_package_id
        WHERE p.client_id = %s AND p.status = 'active'
        ORDER BY p.name
        """,
        (client_id,),
    )
    offers = []
    for row in cursor.fetchall():
        if row["service_type"] != "hotspot":
            continue
        routers = json_list(row.get("availability_routers"))
        if routers and device_id not in routers:
            continue
        offers.append(row)
    return offers


def validity_label(amount, unit):
    amount = int(amount or 0)
    unit = str(unit or "days")
    if amount == 1 and unit.endswith("s"):
        unit = unit[:-1]
    return f"{amount} {unit}"


def validity_seconds(amount, unit):
    return int(amount or 1) * VALIDITY_SECONDS.get(str(unit or "days"), 86400)


def hotspot_page(device, offers, ctx, payment):
    rows = []
    for index, offer in enumerate(offers):
        price = Decimal(offer["price"] or 0)
        rows.append(
            f"""<label class="pick" data-id="{esc(offer['id'])}">
<input type="radio" name="pkg" value="{esc(offer['id'])}"{' checked' if index == 0 else ''}>
<span><span class="nm">{esc(offer['name'])}</span><br>
<span class="sp">{int(offer['download_mbps'])}↓ / {int(offer['upload_mbps'])}↑ Mbps · {esc(validity_label(offer['validity_amount'], offer['validity_unit']))}</span></span>
<span class="pr">KSh {esc(str(price))}</span></label>"""
        )
    if rows:
        picker = "".join(rows)
    else:
        picker = """<p class=note>No hotspot packages are on sale for this router yet. The provider adds them under Packages → Hotspot.</p>"""
    site = esc(f"{device['name']} · {device['site']}".strip(" ·"))
    stk = ""
    if payment:
        stk = """
<label for=phone>M-Pesa number</label>
<input id=phone inputmode=tel placeholder="0712345678">
<button id=paybtn onclick="pay()">Pay with M-Pesa</button>
<div id=msg></div>
<p class=hint>You will get a prompt on the phone to approve. The page updates itself when payment lands and your internet switches on.</p>"""
    else:
        stk = """<p class=note>Online payment is not configured on this network yet. Ask the provider to save M-Pesa details under payment settings.</p>"""
    ctx_json = json.dumps(
        {
            "device": device["id"],
            "ip": ctx.get("ip") or "",
            "mac": ctx.get("mac") or "",
            "login": ctx.get("login") or "",
            "orig": ctx.get("orig") or "",
        }
    )
    script = ""
    if payment:
        script = f"""<script>
const CTX={ctx_json};
let cid=null;
function msg(html,ok){{document.getElementById('msg').innerHTML='<div class='+(ok?'ok':'note')+'>'+html+'</div>';}}
function err(text){{document.getElementById('msg').innerHTML='<div class=err>'+text+'</div>';}}
function sel(){{const p=document.querySelector('input[name=pkg]:checked');return p?p.value:'';}}
async function poll(){{
 if(!cid)return;
 const r=await fetch('/hotspot/status?id='+encodeURIComponent(cid));
 const b=await r.json();
 if(b.state==='paid'){{cid=null;paid(b);return;}}
 if(b.state==='failed'){{cid=null;err(b.reason||'Payment was not completed.');document.getElementById('paybtn').disabled=false;return;}}
 setTimeout(poll,4000);
}}
function paid(b){{
 const card=document.querySelector('.card');
 let html='';
 if(b.warning){{html='<div class=okpage><span class="badge warn">Received</span><h1>Payment received</h1><p class=sub>'+b.warning+'</p></div>';card.innerHTML=html;return;}}
 html='<div class=okpage><span class="badge ok" style="background:#dcfce7;color:#166534">Paid</span><h1>You are online</h1>';
 html+='<p class=sub>Internet is switched on for this device.</p>';
 if(b.username)html+='<div class=creds>Other devices on the same package? Open the hotspot page and sign in with<br>Username: <b>'+b.username+'</b><br>Password: <b>'+b.password+'</b></div>';
 html+='<p class=hint>This window can be closed.</p></div>';
 card.innerHTML=html;
 if(b.loginUrl){{setTimeout(function(){{location.href=b.loginUrl;}},2500);}}
}}
async function pay(){{
 const pkg=sel();
 if(!pkg){{err('Pick a package first.');return;}}
 const phone=document.getElementById('phone').value.trim();
 if(!phone){{err('Enter the M-Pesa number that should approve the payment.');return;}}
 const btn=document.getElementById('paybtn');
 const r=await fetch('/hotspot/pay',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{device:CTX.device,ip:CTX.ip,mac:CTX.mac,login:CTX.login,orig:CTX.orig,packageId:pkg,phone:phone}})}});
 const b=await r.json();
 if(b.checkoutId){{cid=b.checkoutId;btn.disabled=true;msg('Check the phone and approve the M-Pesa prompt…');poll();}}
 else err(b.error||'Could not start the payment.');
}}
document.querySelectorAll('.pick').forEach(function(p){{p.addEventListener('change',function(){{document.querySelectorAll('.pick').forEach(function(x){{x.classList.remove('on');}});p.classList.add('on');}});}});
const first=document.querySelector('.pick');if(first)first.classList.add('on');
</script>"""
    body = f"""<span class="badge warn">Wi-Fi</span>
<h1>Pick a bundle to get online</h1>
<p class=sub>{site}</p>
{picker}
{stk}
{script}"""
    return page("Get online", body).replace(b"</style>", HOTSPOT_CSS.encode() + b"</style>")


def hotspot_login_url(pending, username, password):
    login = str(pending.get("login") or "")
    if not login.startswith("http"):
        return ""
    separator = "&" if "?" in login else "?"
    url = f"{login}{separator}username={quote(username, safe='')}&password={quote(password, safe='')}"
    orig = str(pending.get("orig") or "")
    if orig.startswith("http"):
        url += f"&dst={quote(orig, safe='')}"
    return url


class PortalHandler(BaseHTTPRequestHandler):
    server_version = "ISPCentricPortal/1.0"

    def log_message(self, *args):
        pass

    def _subscriber(self):
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                return identify(cursor, self.client_address[0])
        finally:
            db.close()

    def _send(self, body, status=200, kind="text/html"):
        self.send_response(status)
        self.send_header("Content-Type", f"{kind}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/pay/status":
            return self.pay_status(parse_qs(urlparse(self.path).query).get("id", [""])[0])
        if path.startswith("/hotspot"):
            return self.hotspot_get(path, parse_qs(urlparse(self.path).query))
        row = self._subscriber()
        if not row:
            return self._send(unknown_page())
        if row["status"] == "suspended":
            return self._send(paused_page(row))
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                payment = daraja_settings(cursor, row["client_id"])
        finally:
            db.close()
        self._send(pay_page(row, payment))

    def hotspot_get(self, path, query):
        if path.startswith("/hotspot-page/"):
            body = router_page(path.removeprefix("/hotspot-page/"))
            if body is None:
                return self._send(b"not found", 404, "text/plain")
            return self._send(body)
        if path == "/hotspot/status":
            return self.hotspot_status(query.get("id", [""])[0])
        if path != "/hotspot":
            return self._send(b"not found", 404, "text/plain")
        ctx = {key: query.get(key, [""])[0] for key in ("ip", "mac", "login", "orig")}
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                device = hotspot_device(cursor, self.client_address[0], query.get("d", [""])[0])
                if not device:
                    return self._send(
                        page(
                            "Hotspot not registered",
                            """<span class="badge warn">Wi-Fi</span>
<h1>This hotspot is not set up yet</h1>
<p class=sub>The router that sent you here is not linked to an account.</p>
<p class=note>Reconnect and try again, or contact the provider.</p>""",
                        )
                    )
                offers = hotspot_packages(cursor, device["client_id"], device["id"])
                payment = daraja_settings(cursor, device["client_id"])
        finally:
            db.close()
        self._send(hotspot_page(device, offers, ctx, payment))

    def do_POST(self):
        if urlparse(self.path).path == "/hotspot/pay":
            return self.hotspot_pay()
        if urlparse(self.path).path != "/pay":
            return self._send(b'{"error":"Not found."}', 404, "application/json")
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(min(length, 8192)) or b"{}")
        except (ValueError, OSError):
            return self._send(b'{"error":"Bad request."}', 400, "application/json")
        row = self._subscriber()
        if not row:
            return self._send(b'{"error":"Session not recognized. Reconnect and try again."}', 400, "application/json")
        if row["status"] == "suspended":
            return self._send(b'{"error":"This account is paused by the provider."}', 400, "application/json")
        phone = normalize_phone(payload.get("phone"))
        if not phone:
            return self._send(b'{"error":"Enter a valid Safaricom number, like 0712345678."}', 400, "application/json")
        try:
            amount = Decimal(str(payload.get("amount") or row["price"] or "0")).quantize(Decimal("0.01"))
        except Exception:
            return self._send(b'{"error":"Enter a valid amount."}', 400, "application/json")
        if amount <= 0:
            return self._send(b'{"error":"Enter a valid amount."}', 400, "application/json")
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                settings = daraja_settings(cursor, row["client_id"])
        finally:
            db.close()
        if not settings or not settings["passkey"]:
            return self._send(b'{"error":"M-Pesa prompts are not configured yet."}', 503, "application/json")
        try:
            result = stk_push(settings, phone, amount, row["pppoe_username"])
        except Exception as error:
            return self._send(json.dumps({"error": f"M-Pesa could not start the payment: {error}"}).encode(), 502, "application/json")
        checkout = result.get("CheckoutRequestID")
        if str(result.get("ResponseCode")) != "0" or not checkout:
            return self._send(json.dumps({"error": result.get("errorMessage") or result.get("CustomerMessage") or "M-Pesa rejected the request."}).encode(), 502, "application/json")
        with PENDING_LOCK:
            PENDING[checkout] = {
                "subscriber_id": row["subscriber_id"],
                "client_id": row["client_id"],
                "amount": format(amount, ".2f"),
                "at": datetime.now(),
            }
        self._send(json.dumps({"checkoutId": checkout}).encode(), 200, "application/json")

    def pay_status(self, checkout_id):
        with PENDING_LOCK:
            pending = PENDING.get(checkout_id)
        if not pending:
            return self._send(b'{"state":"failed","reason":"Unknown or expired payment request."}', 200, "application/json")
        if (datetime.now() - pending["at"]).total_seconds() > 180:
            with PENDING_LOCK:
                PENDING.pop(checkout_id, None)
            return self._send(b'{"state":"failed","reason":"The prompt expired. Try again."}', 200, "application/json")
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                settings = daraja_settings(cursor, pending["client_id"])
                if not settings:
                    return self._send(b'{"state":"pending"}', 200, "application/json")
                try:
                    result = stk_query(settings, checkout_id)
                except Exception:
                    return self._send(b'{"state":"pending"}', 200, "application/json")
                code = result.get("ResultCode")
                if code is None or str(code) in ("1037", "1032") and result.get("errorCode"):
                    return self._send(b'{"state":"pending"}', 200, "application/json")
                if str(code) == "0":
                    with PENDING_LOCK:
                        PENDING.pop(checkout_id, None)
                    try:
                        pppoe_store.renew(
                            cursor,
                            pending["client_id"],
                            pending["subscriber_id"],
                            {"amount": pending["amount"], "mpesaReference": checkout_id[-12:]},
                        )
                        db.commit()
                    except Exception as error:
                        db.rollback()
                        return self._send(json.dumps({"state": "failed", "reason": f"Payment landed but activation failed: {error}"}).encode(), 200, "application/json")
                    return self._send(b'{"state":"paid"}', 200, "application/json")
                with PENDING_LOCK:
                    PENDING.pop(checkout_id, None)
                return self._send(json.dumps({"state": "failed", "reason": result.get("ResultDesc") or "Payment was declined."}).encode(), 200, "application/json")
        finally:
            db.close()

    def hotspot_pay(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(min(length, 8192)) or b"{}")
        except (ValueError, OSError):
            return self._send(b'{"error":"Bad request."}', 400, "application/json")
        ip = str(payload.get("ip") or "").strip()[:45]
        mac = str(payload.get("mac") or "").strip().upper()[:20]
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                device = hotspot_device(cursor, self.client_address[0], str(payload.get("device") or ""))
                if not device:
                    return self._send(b'{"error":"This hotspot is not registered."}', 400, "application/json")
                package = next(
                    (row for row in hotspot_packages(cursor, device["client_id"], device["id"]) if row["id"] == str(payload.get("packageId") or "")),
                    None,
                )
                if not package:
                    return self._send(b'{"error":"Pick a package that is on sale."}', 400, "application/json")
                settings = daraja_settings(cursor, device["client_id"])
        finally:
            db.close()
        if not settings or not settings["passkey"]:
            return self._send(b'{"error":"M-Pesa prompts are not configured yet."}', 503, "application/json")
        phone = normalize_phone(payload.get("phone"))
        if not phone:
            return self._send(b'{"error":"Enter a valid Safaricom number, like 0712345678."}', 400, "application/json")
        try:
            result = stk_push(settings, phone, package["price"], str(package["name"] or "Hotspot")[:12])
        except Exception as error:
            return self._send(json.dumps({"error": f"M-Pesa could not start the payment: {error}"}).encode(), 502, "application/json")
        checkout = result.get("CheckoutRequestID")
        if str(result.get("ResponseCode")) != "0" or not checkout:
            return self._send(
                json.dumps({"error": result.get("errorMessage") or result.get("CustomerMessage") or "M-Pesa rejected the request."}).encode(),
                502,
                "application/json",
            )
        purchase_id = str(uuid.uuid4())
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO hotspot_purchases (id, client_id, device_id, package_id, phone, amount, checkout_id, mac, ip, status)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending')
                    """,
                    (
                        purchase_id,
                        device["client_id"],
                        device["id"],
                        package["id"],
                        phone,
                        format(Decimal(package["price"]), ".2f"),
                        checkout,
                        mac,
                        ip,
                    ),
                )
            db.commit()
        finally:
            db.close()
        with HOTSPOT_LOCK:
            HOTSPOT_PENDING[checkout] = {
                "purchase_id": purchase_id,
                "client_id": device["client_id"],
                "tunnel_ip": device["tunnel_ip"],
                "api_secret": device["api_secret"],
                "package_id": package["id"],
                "download": int(package["download_mbps"]),
                "upload": int(package["upload_mbps"]),
                "seconds": validity_seconds(package["validity_amount"], package["validity_unit"]),
                "devices": int(package["devices"] or 1),
                "ip": ip,
                "mac": mac,
                "login": str(payload.get("login") or "")[:200],
                "orig": str(payload.get("orig") or "")[:200],
                "at": datetime.now(),
            }
        self._send(json.dumps({"checkoutId": checkout}).encode(), 200, "application/json")

    def hotspot_authorize(self, pending):
        if not pending.get("api_secret"):
            raise RuntimeError("the router has no saved API access")
        password = routeros_api.open_password(pending["api_secret"])
        username = f"hs-{secrets.token_hex(4)}"
        secret = secrets.token_hex(4)
        profile = f"hs-{pending['package_id'][:8]}"
        rate = f"{pending['upload']}M/{pending['download']}M"
        report = routeros_api.authorize_hotspot_client(
            pending["tunnel_ip"],
            password,
            pending["ip"],
            pending["mac"],
            username,
            secret,
            profile,
            rate,
            pending["devices"],
            f"{pending['seconds']}s",
        )
        return {"username": username, "password": secret, "authorized": True, "online": bool(report.get("online"))}

    def hotspot_status(self, checkout_id):
        with HOTSPOT_LOCK:
            pending = HOTSPOT_PENDING.get(checkout_id)
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                if not pending:
                    cursor.execute("SELECT username, password, status FROM hotspot_purchases WHERE checkout_id = %s", (checkout_id,))
                    row = cursor.fetchone()
                    if row and row["status"] == "paid":
                        return self._send(
                            json.dumps({"state": "paid", "username": row["username"], "password": row["password"]}).encode(),
                            200,
                            "application/json",
                        )
                    return self._send(b'{"state":"failed","reason":"Unknown or expired payment request."}', 200, "application/json")
                if (datetime.now() - pending["at"]).total_seconds() > 180:
                    with HOTSPOT_LOCK:
                        HOTSPOT_PENDING.pop(checkout_id, None)
                    return self._send(b'{"state":"failed","reason":"The prompt expired. Try again."}', 200, "application/json")
                settings = daraja_settings(cursor, pending["client_id"])
                if not settings:
                    return self._send(b'{"state":"pending"}', 200, "application/json")
                try:
                    result = stk_query(settings, checkout_id)
                except Exception:
                    return self._send(b'{"state":"pending"}', 200, "application/json")
                code = result.get("ResultCode")
                if code is None or str(code) in ("1037", "1032") and result.get("errorCode"):
                    return self._send(b'{"state":"pending"}', 200, "application/json")
                if str(code) == "0":
                    try:
                        grant = self.hotspot_authorize(pending)
                    except Exception as error:
                        grant = {"username": "", "password": "", "authorized": False, "error": str(error)}
                    cursor.execute(
                        """
                        UPDATE hotspot_purchases
                        SET status = 'paid', paid_at = NOW(), username = %s, password = %s, authorized = %s
                        WHERE id = %s
                        """,
                        (grant["username"], grant["password"], 1 if grant.get("authorized") else 0, pending["purchase_id"]),
                    )
                    db.commit()
                    with HOTSPOT_LOCK:
                        HOTSPOT_PENDING.pop(checkout_id, None)
                    body = {"state": "paid", "username": grant["username"], "password": grant["password"]}
                    login_url = hotspot_login_url(pending, grant["username"], grant["password"])
                    if login_url:
                        body["loginUrl"] = login_url
                    if not grant.get("authorized"):
                        body["warning"] = "Payment was received but the router did not answer. Show this page to the provider."
                    return self._send(json.dumps(body).encode(), 200, "application/json")
                with HOTSPOT_LOCK:
                    HOTSPOT_PENDING.pop(checkout_id, None)
                cursor.execute("UPDATE hotspot_purchases SET status = 'failed' WHERE id = %s", (pending["purchase_id"],))
                db.commit()
                return self._send(json.dumps({"state": "failed", "reason": result.get("ResultDesc") or "Payment was declined."}).encode(), 200, "application/json")
        finally:
            db.close()


class PortalServer(ThreadingHTTPServer):
    """Refuses to share its port on Windows so a duplicate api.py instance
    fails loudly instead of splitting HTTP and RADIUS across processes. On
    POSIX, SO_REUSEADDR only permits rebinding over TIME_WAIT connections,
    never a second live listener, so restarts do not hit EADDRINUSE."""

    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def start(connect):
    if os.name != "nt":
        import radius_server

        radius_server._allow_posix_port(PORTAL_PORT, "tcp")
    server = PortalServer((PORTAL_HOST, PORTAL_PORT), PortalHandler)
    server.connect = connect
    thread = threading.Thread(target=server.serve_forever, name="portal", daemon=True)
    thread.start()
    STATUS["portal"] = "listening"
    print(f"event=portal host={PORTAL_HOST} port={PORTAL_PORT} status=listening", flush=True)
    return server
