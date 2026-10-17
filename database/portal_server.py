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
import hashlib
import json
import os
import re
import secrets
import socket
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

import pppoe_store
import routeros_api

PORTAL_PORT = int(os.environ.get("ISP_PORTAL_PORT") or 8790)
PORTAL_HOST = os.environ.get("ISP_PORTAL_HOST") or "0.0.0.0"
STATUS = {"portal": "pending"}
DARAJA_TIMEOUT = 8
HOTSPOT_PENDING = {}
HOTSPOT_LOCK = threading.Lock()
VALIDITY_SECONDS = {"hours": 3600, "days": 86400, "weeks": 604800, "months": 2592000}
ANDROID_PROBES = {"/generate_204", "/generate204", "/gen_204"}
PROBE_GRACE = int(os.environ.get("ISP_PROBE_GRACE") or 180)
PROBE_RESTART = int(os.environ.get("ISP_PROBE_RESTART") or 900)
PROBE_SEEN = {}
PROBE_LOCK = threading.Lock()

PAGE_CSS = """
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#0b1220;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:18px;background:#0b1220;background-image:radial-gradient(900px 480px at 12% -8%,rgba(37,99,235,.42),transparent 62%),radial-gradient(760px 420px at 92% 4%,rgba(6,182,212,.26),transparent 60%),linear-gradient(180deg,#0b1220 0%,#101c38 55%,#0b1220 100%);-webkit-font-smoothing:antialiased}
.wrap{width:100%;max-width:432px}
.card{background:#fff;border-radius:22px;padding:26px 24px;box-shadow:0 24px 70px rgba(2,8,26,.55);animation:rise .45s cubic-bezier(.22,1,.36,1)}
@keyframes rise{from{opacity:0;transform:translateY(14px) scale(.985)}to{opacity:1;transform:none}}
.brand{display:flex;align-items:center;gap:11px;margin-bottom:20px}
.logo{width:38px;height:38px;flex-shrink:0;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#1d4ed8,#0891b2);box-shadow:0 6px 16px rgba(29,78,216,.35)}
.logo svg{width:20px;height:20px}
.bname{font-size:13px;font-weight:800;letter-spacing:.14em;color:#0b1220}
.bname small{display:block;font-size:10px;font-weight:600;letter-spacing:.06em;color:#64748b;margin-top:1px}
.ic{width:52px;height:52px;border-radius:16px;display:flex;align-items:center;justify-content:center;margin-bottom:14px}
.ic svg{width:26px;height:26px}
.ic.amber{background:#fef3c7;color:#b45309}
.ic.red{background:#fee2e2;color:#dc2626}
.ic.blue{background:#eff6ff;color:#1d4ed8}
.ic.green{background:#ecfdf5;color:#059669}
h1{font-size:21px;line-height:1.28;letter-spacing:-.01em;margin-bottom:6px}
.sub{color:#64748b;font-size:13.5px;line-height:1.55;margin-bottom:16px}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;padding:5px 11px;border-radius:999px;margin-bottom:12px}
.badge:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.badge.warn{background:#fef3c7;color:#92400e}
.badge.bad{background:#fee2e2;color:#b91c1c}
.badge.ok{background:#dcfce7;color:#166534}
.badge.blue{background:#eff6ff;color:#1d4ed8}
.sect{font-size:11.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#64748b;margin:18px 0 8px}
.row{display:flex;justify-content:space-between;gap:14px;font-size:14px;padding:9px 0;border-bottom:1px solid #eef2f7}
.row:last-of-type{border-bottom:0}
.row span:first-child{color:#64748b}
.row span:last-child{font-weight:600;text-align:right}
label{display:block;font-size:13px;font-weight:600;color:#334155;margin:15px 0 6px}
input{width:100%;padding:12px 14px;border:1.5px solid #d5deea;border-radius:12px;font-size:16px;font-family:inherit;background:#fff;color:#0b1220;transition:border-color .15s,box-shadow .15s;-webkit-appearance:none;appearance:none}
input:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 4px rgba(37,99,235,.14)}
input::placeholder{color:#94a3b8}
input[type=number]{-moz-appearance:textfield}
input::-webkit-outer-spin-button,input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
button{width:100%;margin-top:18px;padding:14px;border:0;border-radius:12px;background:linear-gradient(135deg,#1d4ed8,#1e40af);color:#fff;font-size:15.5px;font-weight:700;font-family:inherit;letter-spacing:.01em;cursor:pointer;box-shadow:0 10px 22px rgba(29,78,216,.32);transition:filter .15s,transform .15s,box-shadow .15s}
button:hover{filter:brightness(1.07)}
button:active{transform:translateY(1px)}
button:disabled{background:#c7d2e0;box-shadow:none;cursor:default;transform:none}
.hint{font-size:12.5px;color:#64748b;line-height:1.55;margin-top:10px}
#days{min-height:18px;color:#1d4ed8;font-weight:600}
.note{margin-top:16px;padding:12px 14px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;font-size:12.5px;color:#475569;line-height:1.6}
.err{margin-top:14px;padding:11px 14px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:12px;font-size:13px;font-weight:500;line-height:1.5}
.ok{margin-top:14px;padding:11px 14px;background:#ecfdf5;border:1px solid #bbf7d0;color:#047857;border-radius:12px;font-size:13px;font-weight:600;line-height:1.5}
.okpage{text-align:center;padding:6px 0 2px}
.okpage .ic{margin-left:auto;margin-right:auto}
.done{width:66px;height:66px;margin:2px auto 16px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#ecfdf5;color:#059669;box-shadow:0 0 0 9px rgba(16,185,129,.12)}
.done svg{width:30px;height:30px}
.spin{display:inline-block;width:26px;height:26px;border-radius:50%;border:3px solid #dbe7f6;border-top-color:#1d4ed8;animation:rot .8s linear infinite}
.spin.big{width:40px;height:40px;border-width:4px}
.spin.g{border-color:#d1fae5;border-top-color:#059669}
@keyframes rot{to{transform:rotate(360deg)}}
.voucher{margin-top:16px;padding:14px 16px;background:#f8fafc;border:1.5px dashed #cbd5e1;border-radius:12px;text-align:center}
.voucher small{display:block;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#64748b;margin-bottom:6px}
.voucher code{display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:21px;font-weight:800;letter-spacing:.12em;color:#1d4ed8;background:#eef2f7;padding:4px 12px;border-radius:8px}
.vcode{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;font-weight:700;letter-spacing:.08em;color:#1d4ed8}
.foot{margin-top:16px;text-align:center;font-size:11px;font-weight:600;letter-spacing:.08em;color:rgba(255,255,255,.5)}
@media(max-width:420px){body{padding:14px}.card{padding:22px 18px;border-radius:20px}h1{font-size:19px}}
"""


def _icon(paths):
    return (
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
        f'stroke-linecap="round" stroke-linejoin="round">{paths}</svg>'
    )


ICON_WIFI = _icon(
    '<path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/>'
    '<path d="M2 9a15 15 0 0 1 20 0"/><path d="M12 20h.01"/>'
)
ICON_WIFIOFF = _icon(
    '<line x1="2" y1="2" x2="22" y2="22"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/>'
    '<path d="M2 8.82a15 15 0 0 1 4.17-2.65"/><path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"/>'
    '<path d="M16.85 11.25a10 10 0 0 1 2.22 1.68"/><path d="M5 13a10 10 0 0 1 5.24-2.76"/>'
    '<line x1="12" y1="20" x2="12.01" y2="20"/>'
)
ICON_PAUSE = _icon('<rect x="6" y="4" width="4" height="16" rx="1.5"/><rect x="14" y="4" width="4" height="16" rx="1.5"/>')
ICON_ALERT = _icon(
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>'
    '<path d="M12 9v4"/><path d="M12 17h.01"/>'
)
ICON_CHECK = _icon('<path d="M20 6 9 17l-5-5"/>')

BRAND = (
    f'<div class=brand><span class=logo>{ICON_WIFI}</span>'
    '<span class=bname>ISP CENTRIC<small>Secure payment portal</small></span></div>'
)
DONE_ICON = f'<span class=done>{ICON_CHECK}</span>'
WARN_ICON = f'<span class="ic amber">{ICON_ALERT}</span>'


def page(title, body, head=""):
    return (
        "<!doctype html><html><head><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width,initial-scale=1'>"
        f"{head}<title>{title}</title><style>{PAGE_CSS}</style></head>"
        f"<body><div class=wrap><div class=card>{BRAND}{body}</div>"
        '<p class=foot>Powered by ISP CENTRIC</p></div></body></html>'
    ).encode()


def esc(value):
    return str(value or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def identify(cursor, ip):
    cursor.execute(
        """
        SELECT s.id AS subscriber_id, s.client_id, s.first_name, s.last_name, s.phone,
               s.pppoe_username, s.status, s.router_id, s.package_id,
               p.name AS package_name, p.download_mbps, p.upload_mbps,
               p.simultaneous_devices AS package_devices,
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
        "SELECT scope, environment, account_type, short_code, consumer_key, consumer_secret, passkey, callback_url FROM isp_payment_settings WHERE client_id = %s",
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


DARAJA_TOKENS = {}
DARAJA_TOKEN_LOCK = threading.Lock()


def daraja_token(row):
    """Cached OAuth token — Daraja tokens live ~1h, so reuse them instead of
    paying an extra auth round-trip on every STK push and status query."""
    cache_key = (row["environment"], row["consumer_key"])
    with DARAJA_TOKEN_LOCK:
        cached = DARAJA_TOKENS.get(cache_key)
    if cached and cached[1] > time.time() + 60:
        return cached[0]
    key = row["consumer_key"]
    secret = row["consumer_secret"]
    token_req = urllib.request.Request(
        f"{daraja_host(row)}/oauth/v1/generate?grant_type=client_credentials",
        headers={"Authorization": "Basic " + base64.b64encode(f"{key}:{secret}".encode()).decode()},
    )
    with urllib.request.urlopen(token_req, timeout=DARAJA_TIMEOUT) as response:
        body = json.loads(response.read().decode() or "{}")
    token = body.get("access_token")
    if not token:
        raise RuntimeError("Daraja did not return an access token.")
    expires = int(body.get("expires_in") or 3600)
    with DARAJA_TOKEN_LOCK:
        DARAJA_TOKENS[cache_key] = (token, time.time() + expires)
    return token


def daraja_request(row, path, payload):
    token = daraja_token(row)
    request = urllib.request.Request(
        f"{daraja_host(row)}{path}",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=DARAJA_TIMEOUT) as response:
            return json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            with DARAJA_TOKEN_LOCK:
                DARAJA_TOKENS.pop((row["environment"], row["consumer_key"]), None)
        try:
            body = json.loads(error.read().decode() or "{}")
        except ValueError:
            body = {}
        if body:
            return body
        raise RuntimeError(f"Daraja answered with an error ({error.code}).") from error


def whole_shillings(value):
    """M-Pesa only accepts whole-shilling amounts; never charge less than quoted."""
    return max(1, int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP)))


def stk_push(row, phone, amount, reference):
    stamp_now = datetime.now().strftime("%Y%m%d%H%M%S")
    shortcode = str(row["short_code"])
    payload = {
        "BusinessShortCode": shortcode,
        "Password": base64.b64encode(f"{shortcode}{row['passkey']}{stamp_now}".encode()).decode(),
        "Timestamp": stamp_now,
        "TransactionType": "CustomerPayBillOnline" if row["account_type"] == "paybill" else "CustomerBuyGoodsOnline",
        "Amount": whole_shillings(amount),
        "PartyA": phone,
        "PartyB": shortcode,
        "PhoneNumber": phone,
        "CallBackURL": str(row.get("callback_url") or "").strip()
        or os.environ.get("ISP_DARAJA_CALLBACK", "https://portal.ispcentric.local/callback"),
        "AccountReference": str(reference)[:12],
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


def stk_state(result):
    """Classify an stkpushquery reply as paid, still pending, or failed."""
    code = result.get("ResultCode")
    if code is not None:
        if str(code) == "0":
            return "paid", ""
        if str(code) in ("1032", "1037") and result.get("errorCode"):
            return "pending", ""
        return "failed", str(result.get("ResultDesc") or "Payment was declined.")
    error = str(result.get("errorCode") or "")
    if not error or error.startswith("500"):
        return "pending", ""
    return "failed", str(result.get("errorMessage") or "The payment could not be confirmed.")


def pppoe_packages(cursor, client_id, router_id):
    cursor.execute(
        """
        SELECT p.id, p.name, p.price, p.download_mbps, p.upload_mbps, p.availability_routers,
               p.simultaneous_devices,
               COALESCE(p.service_type, c.service_type, 'pppoe') AS service_type,
               COALESCE(p.validity_amount, c.validity_amount, 1) AS validity_amount,
               COALESCE(p.validity_unit, c.validity_unit, 'months') AS validity_unit,
               COALESCE(p.image_data_url, c.image_data_url) AS image_data_url
        FROM isp_packages p
        LEFT JOIN company_packages c ON c.id = p.company_package_id
        WHERE p.client_id = %s AND p.status = 'active'
        ORDER BY p.price, p.name
        """,
        (client_id,),
    )
    offers = []
    for row in cursor.fetchall():
        if row["service_type"] != "pppoe":
            continue
        routers = json_list(row.get("availability_routers"))
        if routers and router_id not in routers:
            continue
        row["period"] = validity_label(row["validity_amount"], row["validity_unit"])
        offers.append(row)
    return offers


def pppoe_offers(cursor, row):
    """Active PPPoE packages for this router, with the subscriber's own
    package kept on the list even after it is suspended or archived.

    Prices always come from isp_packages so a package edit shows up here
    immediately; the subscription's frozen price is only used when the
    package itself is no longer on sale."""
    offers = pppoe_packages(cursor, row["client_id"], str(row.get("router_id") or ""))
    own = next((offer for offer in offers if str(offer["id"]) == str(row["package_id"])), None)
    if own is None:
        offers.insert(
            0,
            {
                "id": row["package_id"],
                "name": row["package_name"],
                "price": row["price"],
                "download_mbps": row["download_mbps"],
                "upload_mbps": row["upload_mbps"],
                "simultaneous_devices": row.get("package_devices"),
                "image_data_url": None,
                "period": f"{int(row['cycle_days'] or 30)} days",
            },
        )
    return offers


def pppoe_pick(offer, checked):
    price = Decimal(offer["price"] or 0)
    image = str(offer.get("image_data_url") or "")
    thumb = (
        f'<img class=pi src="{esc(image)}" alt="">'
        if image.startswith("data:image/")
        else '<span class="pi noimg">Wi-Fi</span>'
    )
    devices = int(offer.get("simultaneous_devices") or 0)
    device_text = "Unlimited devices" if devices <= 0 else f"Up to {devices} device{'s' if devices != 1 else ''}"
    return f"""<label class="pick">
<input type="radio" name="pkg" value="{esc(offer['id'])}"{' checked' if checked else ''}>
<span class=tick></span>
{thumb}
<span class=pd><span class="nm">{esc(offer['name'])}</span>
<span class="sp">{int(offer['download_mbps'])} Mbps ↓ · {int(offer['upload_mbps'])} Mbps ↑ · {esc(offer['period'])}</span>
<span class="sp">{esc(device_text)}</span></span>
<span class="pr">KSh {esc(ksh(price))}</span></label>"""


def paused_page(row):
    name = esc(f"{row['first_name']} {row['last_name']}".strip()) or "Customer"
    return page(
        "Account paused",
        f"""<span class="ic amber">{ICON_PAUSE}</span>
<span class="badge warn">Paused</span>
<h1>Hi {name}, your internet is paused</h1>
<p class=sub>Your account was paused by the provider, so browsing is on hold for now.</p>
<div class=row><span>Package</span><span>{esc(row['package_name'])}</span></div>
<div class=row><span>Username</span><span>{esc(row['pppoe_username'])}</span></div>
<p class=note>If this looks wrong, contact support and quote your username above. Once the pause is lifted you will be back online automatically.</p>""",
    )


def pay_page(row, offers, payment):
    name = esc(f"{row['first_name']} {row['last_name']}".strip()) or "Customer"
    phone = esc(row["phone"])
    own = str(row["package_id"] or "")
    own_listed = any(str(offer["id"]) == own for offer in offers)
    picks = "".join(
        pppoe_pick(offer, str(offer["id"]) == own or (not own_listed and index == 0))
        for index, offer in enumerate(offers)
    )
    if not picks:
        picks = "<p class=note>No packages are on sale right now. Contact the provider to recharge your line.</p>"
    pkg_js = {str(offer["id"]): cents(offer["price"]) for offer in offers}
    cycle = int(row["cycle_days"] or 30)
    chosen_offer = next(
        (offer for offer in offers if str(offer["id"]) == own or not own_listed), offers[0] if offers else None
    )
    default_price = ksh(chosen_offer["price"]) if chosen_offer else "0"
    stk = ""
    if payment:
        stk = f"""
<p class=sect>Pay with M-Pesa</p>
<label for=phone>M-Pesa phone number</label>
<input id=phone inputmode=tel autocomplete=tel placeholder="0712 345 678" value="{phone}">
<label for=amount>Amount (KSh)</label>
<input id=amount inputmode=decimal value="{esc(default_price)}">
<p class=hint id=days></p>
<button id=paybtn type=button onclick="pay()">Pay with M-Pesa</button>
<div id=msg aria-live=polite></div>
<p class=hint>You'll get a prompt on the phone to approve. This page updates itself when the payment lands.</p>
<script>
const BRAND={json.dumps(BRAND)};
const PKG={json.dumps(pkg_js)};
const CYCLE={cycle};
const SIG={json.dumps(pay_signature(row, offers, payment))};
let cid=null;
let dirty=false;
let voucher='';
let tries=0;
function money(cents){{return 'KSh '+(cents%100?(cents/100).toFixed(2):String(cents/100));}}
function sel(){{const p=document.querySelector('input[name=pkg]:checked');return p?p.value:'';}}
function refresh(){{
 document.querySelectorAll('.pick').forEach(function(x){{const r=x.querySelector('input[name=pkg]');x.classList.toggle('on',!!(r&&r.checked));}});
 const p=PKG[sel()];
 const amt=document.getElementById('amount');
 const c=Math.round(parseFloat(amt.value||'0')*100)||0;
 const d=p&&c>0?Math.max(1,Math.floor(c*CYCLE/p)):0;
 const dd=document.getElementById('days');
 if(dd)dd.textContent=p?(d>0?'Buys '+d+' day'+(d===1?'':'s')+' of internet.':''):'';
 const b=document.getElementById('paybtn');
 if(b&&!b.disabled)b.textContent=c>0?'Pay '+money(c)+' with M-Pesa':'Pay with M-Pesa';
}}
function pickpkg(){{
 const p=PKG[sel()];const amt=document.getElementById('amount');
 if(p&&amt)amt.value=String(p/100);
 refresh();
}}
function stage(html){{document.querySelector('.card').innerHTML=BRAND+html;}}
function waitPin(){{
 stage('<div class=okpage><p style="margin:8px 0 14px"><span class="spin big"></span></p><span class="badge blue">M-Pesa</span><h1>Approve on your phone</h1><p class=sub>Enter your M-Pesa PIN on the prompt sent to your phone. This page updates itself — no need to refresh.</p></div>');
}}
function connecting(){{
 stage('<div class=okpage><p style="margin:8px 0 14px"><span class="spin big g"></span></p><span class="badge ok">Paid</span><h1>Payment received</h1><p class=sub>Reconnecting you to the internet — hold on…</p><p class=hint id=later></p></div>');
}}
function fail(reason){{
 cid=null;
 stage('<div class=okpage><span class="badge bad">Not completed</span><h1>Payment not completed</h1><p class=sub>'+reason+'</p><button type=button onclick="retry()">Try again</button></div>');
}}
function retry(){{saveState();location.reload();}}
function thanks(){{
 const code=voucher;cid=null;
 location.href='/thank-you'+(code?'?code='+encodeURIComponent(code):'');
}}
async function poll(){{
 if(!cid)return;
 try{{
  const r=await fetch('/pay/status?id='+encodeURIComponent(cid));
  const b=await r.json();
  if(b.state==='paid'){{voucher=b.voucher||'';connecting();setTimeout(online,1500);return;}}
  if(b.state==='failed'){{fail(b.reason||'Payment was not completed.');return;}}
 }}catch(e){{}}
 setTimeout(poll,2500);
}}
async function online(){{
 if(!cid)return;
 try{{
  const r=await fetch('/pay/online?id='+encodeURIComponent(cid));
  const b=await r.json();
  if(b.state==='online'){{thanks();return;}}
 }}catch(e){{}}
 tries+=1;
 if(tries>30){{cid=null;location.href='/help';return;}}
 if(tries===10){{const l=document.getElementById('later');if(l)l.textContent='Still working on it — reconnects can take a minute or two after payment.';}}
 setTimeout(online,3000);
}}
async function pay(){{
 const pkg=sel();
 if(!pkg){{document.getElementById('msg').innerHTML='<div class=err>Pick a package first.</div>';return;}}
 const r=await fetch('/pay',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{phone:document.getElementById('phone').value,packageId:pkg,amount:document.getElementById('amount').value}})}});
 const b=await r.json();
 if(b.checkoutId){{cid=b.checkoutId;waitPin();poll();}}
 else document.getElementById('msg').innerHTML='<div class=err>'+(b.error||'Could not start the payment.')+'</div>';
}}
document.querySelectorAll('input[name=pkg]').forEach(function(r){{r.addEventListener('change',pickpkg);}});
const amtbox=document.getElementById('amount');if(amtbox)amtbox.addEventListener('input',function(){{dirty=true;refresh();}});
function saveState(){{
 try{{
  sessionStorage.setItem('recharge',JSON.stringify({{p:sel(),ph:(document.getElementById('phone')||{{}}).value||'',am:dirty?amtbox.value:''}}));
 }}catch(e){{}}
}}
async function fresh(){{
 if(cid)return;
 try{{
  const r=await fetch('/pay/offers');const b=await r.json();
  if(!b.sig||b.state!=='sale'||b.sig!==SIG){{saveState();location.reload();}}
 }}catch(e){{}}
}}
try{{
 const s=JSON.parse(sessionStorage.getItem('recharge')||'null');
 if(s){{sessionStorage.removeItem('recharge');
  const inp=document.querySelector('input[name=pkg][value="'+s.p+'"]');if(inp)inp.checked=true;
  const ph=document.getElementById('phone');if(ph&&s.ph)ph.value=s.ph;
  if(amtbox&&s.am){{amtbox.value=s.am;dirty=true;}}
 }}
}}catch(e){{}}
setInterval(fresh,15000);
document.addEventListener('visibilitychange',function(){{if(!document.hidden)fresh();}});
refresh();
</script>"""
    manual = ""
    if payment:
        kind = "Paybill" if payment["account_type"] == "paybill" else "Till"
        manual = f"""<p class=note><b>Or pay manually:</b> Lipa na M-Pesa → {kind} <b>{esc(payment['short_code'])}</b> → Account <b>{esc(row['pppoe_username'])}</b>. Your line reconnects as soon as the payment is confirmed.</p>"""
    else:
        manual = "<p class=note>Online payment is not configured yet. Contact support to recharge your line.</p>"
    return page(
        "Recharge internet",
        f"""<span class="ic red">{ICON_WIFIOFF}</span>
<span class="badge bad">Offline</span>
<h1>Hi {name}, let's get you back online</h1>
<p class=sub>Pick a package and pay — your internet comes back on its own, no call needed.</p>
<p class=sect>Choose a package</p>
{picks}
{stk}{manual}""",
    ).replace(b"</style>", HOTSPOT_CSS.encode() + b"</style>")


def help_page():
    return page(
        "Still offline",
        f"""{WARN_ICON}
<span class="badge warn">Paid · not connected</span>
<h1>Your payment went through, but the link has not come back yet</h1>
<p class=sub>Your payment is recorded already — this is only the reconnect taking too long. Try these in order:</p>
<p class=sect>Get back online</p>
<div class=row><span>Step 1</span><span>Turn Wi-Fi off and back on, on this device.</span></div>
<div class=row><span>Step 2</span><span>Restart the router — off for 30 seconds, then on. It re-dials by itself.</span></div>
<div class=row><span>Step 3</span><span>Give it five more minutes — reconnects can lag behind the payment.</span></div>
<p class=note>Still offline after a restart? Contact the provider and quote your M-Pesa receipt code — the payment is already on your account.</p>""",
    )


def unknown_page():
    return page(
        "Internet blocked",
        f"""<span class="ic amber">{ICON_ALERT}</span>
<span class="badge warn">Blocked</span>
<h1>This connection has no active subscription</h1>
<p class=sub>We could not match this session to an account.</p>
<p class=note>Reconnect your PPPoE link, then open this page again. If it keeps showing, contact support.</p>""",
    )


def thankyou_page(voucher):
    if not voucher:
        return page(
            "Thank you",
            f"""<div class=okpage>{DONE_ICON}
<span class="badge ok">Paid</span>
<h1>Thank you for your payment</h1>
<p class=sub>Your payment was received and your internet is reconnecting now.</p>
<p class=hint>You can close this window and start browsing.</p></div>""",
        )
    name = esc(f"{voucher['first_name']} {voucher['last_name']}".strip()) or "Customer"
    used = voucher["status"] == "used"
    state = (
        "Already used — this voucher was spent once you started surfing and cannot be used again."
        if used
        else "Single use — the voucher is spent as soon as you start surfing and cannot be used again."
    )
    badge = '<span class="badge warn">Voucher used</span>' if used else '<span class="badge ok">Payment successful</span>'
    return page(
        "Thank you",
        f"""<div class=okpage>{DONE_ICON}
{badge}
<h1>Thank you, {name}!</h1>
<p class=sub>Your subscription is active and your internet is reconnecting now.</p></div>
<div class=voucher><small>Voucher code</small><code>{esc(voucher['code'])}</code></div>
<p class=sect>Receipt</p>
<div class=row><span>Package</span><span>{esc(voucher['package_name'])}</span></div>
<div class=row><span>Amount paid</span><span>KSh {esc(ksh(voucher['amount']))}</span></div>
<div class=row><span>Account</span><span>{esc(voucher['pppoe_username'])}</span></div>
<p class=note>{state} Keep it as your receipt.</p>
<p class=hint style="text-align:center">You can close this window and start browsing.</p>""",
    )


def thankyou_hotspot_page(receipt):
    if not receipt:
        return page(
            "Thank you",
            f"""<div class=okpage>{DONE_ICON}
<span class="badge ok">Paid</span>
<h1>Thank you for your payment</h1>
<p class=sub>Your payment was received and this device is connected.</p>
<p class=hint>You can close this window and start browsing.</p></div>""",
        )
    vouchers = receipt["vouchers"]
    listing = "".join(
        f'<div class=row><span><b class=vcode>{esc(voucher["code"])}</b></span>'
        f'<span>{"Used" if voucher["status"] == "used" else "Ready"}</span></div>'
        for voucher in vouchers
    ) or "<p class=note>No vouchers were issued for this purchase.</p>"
    share = ""
    if len(vouchers) > 1:
        share = (
            "<p class=note>Share the ready codes — each one connects one more device. On that device, open this "
            "Wi-Fi page and enter the code under <b>Have a voucher?</b></p>"
        )
    return page(
        "Thank you",
        f"""<div class=okpage>{DONE_ICON}
<span class="badge ok">Payment successful</span>
<h1>Thank you — you're online</h1>
<p class=sub>Your Wi-Fi bundle is active on this device.</p></div>
<div class=row><span>Package</span><span>{esc(receipt['package_name'])}</span></div>
<div class=row><span>Amount paid</span><span>KSh {esc(ksh(receipt['amount']))}</span></div>
<p class=sect>Voucher{'' if len(vouchers) == 1 else 's'} for this purchase</p>
{listing}
{share}
<p class=note>A voucher is spent once its device starts surfing and cannot be used again.</p>""",
    )


HOTSPOT_CSS = """
.tabs{display:flex;gap:4px;padding:4px;background:#eef2f7;border-radius:14px;margin-bottom:14px}
.tab{flex:1;margin-top:0;padding:9px 10px;border:0;border-radius:10px;background:transparent;color:#64748b;font-size:13.5px;font-weight:600;box-shadow:none;cursor:pointer}
.tab:hover{filter:none;color:#0f172a}
.tab:active{transform:none}
.tab.on{background:#fff;color:#1d4ed8;box-shadow:0 1px 4px rgba(15,23,42,.14)}
.tab.on:hover{color:#1d4ed8}
.pick{position:relative;display:flex;gap:12px;align-items:center;padding:12px 13px;margin:0 0 10px;border:1.5px solid #e2e8f0;border-radius:14px;background:#fff;font-weight:400;cursor:pointer;transition:border-color .15s ease,background .15s ease,box-shadow .15s ease}
.pick:hover{border-color:#bfdbfe}
.pick input{position:absolute;width:1px;height:1px;opacity:0;margin:0;padding:0;border:0}
.tick{width:20px;height:20px;flex-shrink:0;border-radius:50%;border:2px solid #cbd5e1;background:#fff;display:flex;align-items:center;justify-content:center;transition:border-color .15s}
.pick.on{border-color:#1d4ed8;background:#f5f9ff;box-shadow:0 0 0 3px rgba(37,99,235,.12)}
.pick.on .tick{border-color:#1d4ed8}
.pick.on .tick:after{content:"";width:8px;height:8px;border-radius:50%;background:#1d4ed8}
.pick .pi{width:58px;height:44px;border-radius:10px;object-fit:cover;flex-shrink:0}
.pick .noimg{display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#eff6ff,#e0f2fe);color:#1d4ed8;font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}
.pick .pd{flex:1;min-width:0}
.pick .nm{display:block;font-size:14px;font-weight:700;color:#0b1220}
.pick .sp{display:block;font-size:12px;color:#64748b;line-height:1.55;margin-top:1px}
.pick .pr{margin-left:auto;font-size:15px;font-weight:800;color:#0b1220;white-space:nowrap}
.cust{display:none;margin:-4px 0 10px;padding:12px 14px 8px;border:1.5px solid #bfdbfe;border-top:0;border-radius:0 0 14px 14px;background:#f8fbff}
.crow{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;font-weight:500;color:#334155;padding:5px 0}
.crow input{width:84px;padding:8px 10px;font-size:15px;text-align:center}
.crow i{color:#94a3b8;font-style:normal;font-size:11px;font-weight:400}
.crow.total{border-top:1px dashed #cbd5e1;margin-top:6px;padding-top:10px;font-weight:700;color:#0b1220}
.crow.total b{font-size:15px;color:#1d4ed8}
.creds{margin-top:16px;padding:13px 15px;background:#f8fafc;border:1.5px dashed #cbd5e1;border-radius:12px;font-size:13px;line-height:1.7;text-align:left;color:#334155}
.creds b{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#eef2f7;padding:1px 6px;border-radius:6px;user-select:all;-webkit-user-select:all;cursor:pointer}
.creds i{color:#94a3b8;font-style:normal;font-size:11px}
.redeem{display:flex;gap:8px}
.redeem input{flex:1;min-width:0;text-transform:uppercase;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;letter-spacing:.08em}
.redeem button{width:auto;margin-top:0;padding:12px 18px;white-space:nowrap}
"""


def portal_base():
    host = os.environ.get("ISP_PORTAL_IP") or "10.88.0.1"
    return f"http://{host}:{PORTAL_PORT}"


def router_page(name):
    """Pages fetched onto the router; $(...) tokens are filled by RouterOS."""
    if name == "login.html":
        return page(
            "Opening portal",
            f"""<span class="ic blue">{ICON_WIFI}</span>
<h1>Opening the payment page…</h1>
<p class=sub>Connecting you to the secure payment page.</p>
<p style="text-align:center;margin-top:8px"><span class=spin></span></p>""",
            f'<meta http-equiv="refresh" content="0; url={portal_base()}/hotspot?login=$(link-login-only)&orig=$(link-orig-esc)&ip=$(ip)&mac=$(mac-esc)">',
        )
    if name == "status.html":
        return page(
            "Connected",
            f"""<div class=okpage>{DONE_ICON}
<span class="badge ok">Online</span>
<h1>You are connected</h1>
<p class=sub>Your internet is on. Taking you back to where you were going…</p></div>""",
            '<meta http-equiv="refresh" content="3; url=$(link-orig)">',
        )
    if name == "error.html":
        return page(
            "Could not connect",
            f"""<span class="ic red">{ICON_ALERT}</span>
<span class="badge bad">Error</span>
<h1>Could not connect</h1>
<p class=err style="margin-top:0">$(error)</p>
<p class=note>Try again, or pay again if your session ran out.</p>""",
        )
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
               COALESCE(p.simultaneous_devices, c.simultaneous_devices, 1) AS devices,
               COALESCE(p.extra_device_price, c.extra_device_price) AS extra_device_price,
               COALESCE(p.extra_period_price, c.extra_period_price) AS extra_period_price,
               COALESCE(p.image_data_url, c.image_data_url) AS image_data_url
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


def offers_signature(offers, extra=""):
    """Fingerprint of everything the pay pages render — when it changes an
    open page reloads once instead of showing a stale price or package."""
    parts = [str(extra)]
    for offer in offers:
        parts.append(
            "|".join(
                str(offer.get(key) or "")
                for key in (
                    "id", "name", "price", "download_mbps", "upload_mbps", "period",
                    "simultaneous_devices", "devices", "validity_amount", "validity_unit",
                    "extra_device_price", "extra_period_price", "image_data_url",
                )
            )
        )
    return hashlib.sha1("\x00".join(parts).encode()).hexdigest()


def pay_signature(row, offers, payment):
    return offers_signature(
        offers,
        f"{int(bool(payment))}|{row['package_id']}|{row['price']}|{row['cycle_days']}",
    )


def hotspot_signature(offers, payment):
    return offers_signature(offers, str(int(bool(payment))))


def validity_label(amount, unit):
    amount = int(amount or 0)
    unit = str(unit or "days")
    if amount == 1 and unit.endswith("s"):
        unit = unit[:-1]
    return f"{amount} {unit}"


def validity_seconds(amount, unit):
    return int(amount or 1) * VALIDITY_SECONDS.get(str(unit or "days"), 86400)


def ksh(value):
    return format(Decimal(str(value or "0")).quantize(Decimal("0.01")).normalize(), "f")


def cents(value):
    return int((Decimal(str(value or "0")) * 100).quantize(Decimal("1")))


def unit_label(amount, unit):
    unit = str(unit or "days")
    if int(amount or 1) == 1 and unit.endswith("s"):
        return unit[:-1]
    return f"{int(amount or 1)} {unit}"


def hotspot_offer_detail(offer):
    devices = int(offer["devices"] or 0)
    period = validity_label(offer["validity_amount"], offer["validity_unit"])
    if devices > 1:
        return f"Up to {devices} devices · {period}"
    if devices:
        return "1 device"
    each = unit_label(offer["validity_amount"], offer["validity_unit"])
    extra_device = ksh(offer["extra_device_price"])
    extra_period = ksh(offer["extra_period_price"])
    return f"1 device · {period} included — +KSh {extra_device} each extra device · +KSh {extra_period} each extra {each}"


def hotspot_pick(offer, checked, customize):
    price = Decimal(offer["price"] or 0)
    image = str(offer.get("image_data_url") or "")
    thumb = (
        f'<img class=pi src="{esc(image)}" alt="">'
        if image.startswith("data:image/")
        else '<span class="pi noimg">Wi-Fi</span>'
    )
    row = f"""<label class="pick">
<input type="radio" name="pkg" value="{esc(offer['id'])}"{' checked' if checked else ''}>
<span class=tick></span>
{thumb}
<span class=pd><span class="nm">{esc(offer['name'])}</span>
<span class="sp">{int(offer['download_mbps'])} Mbps ↓ · {int(offer['upload_mbps'])} Mbps ↑ · {esc(validity_label(offer['validity_amount'], offer['validity_unit']))}</span>
<span class="sp">{esc(hotspot_offer_detail(offer))}</span></span>
<span class="pr">KSh {esc(ksh(price))}</span></label>"""
    if customize:
        each = unit_label(offer["validity_amount"], offer["validity_unit"])
        row += f"""<div class="cust" id="cust-{esc(offer['id'])}">
<div class=crow><span>Devices</span><input id="dev-{esc(offer['id'])}" type=number min=1 max=50 value=2 inputmode=numeric></div>
<div class=crow><span>Periods <i>(1 = {esc(each)})</i></span><input id="per-{esc(offer['id'])}" type=number min=1 max=60 value=1 inputmode=numeric></div>
<div class="crow total"><span>Total</span><b id="tot-{esc(offer['id'])}"></b></div>
</div>"""
    return row


def bounded_int(value, minimum, maximum):
    try:
        number = int(str(value or "").strip())
    except (TypeError, ValueError):
        return None
    if number < minimum or number > maximum:
        return None
    return number


def hotspot_quote(package, payload):
    """Resolve the devices, periods, and amount a purchase covers."""
    base = Decimal(package["price"] or 0)
    seconds = validity_seconds(package["validity_amount"], package["validity_unit"])
    fixed = int(package["devices"] or 0)
    if fixed:
        return {"devices": fixed, "periods": 1, "amount": base, "seconds": seconds}
    devices = bounded_int(payload.get("devices"), 1, 50)
    periods = bounded_int(payload.get("periods"), 1, 60)
    if not devices or not periods:
        return None
    amount = base + (devices - 1) * Decimal(package["extra_device_price"] or 0) + (periods - 1) * Decimal(
        package["extra_period_price"] or 0
    )
    return {"devices": devices, "periods": periods, "amount": amount, "seconds": periods * seconds}


def hotspot_page(device, offers, ctx, payment):
    single = [offer for offer in offers if int(offer["devices"] or 0) == 1]
    multi = [offer for offer in offers if int(offer["devices"] or 0) != 1]
    mode = "one" if single else "multi"
    pkg_js = {}
    for offer in offers:
        custom = not int(offer["devices"] or 0)
        pkg_js[str(offer["id"])] = {
            "b": cents(offer["price"]),
            "d": cents(offer["extra_device_price"]),
            "p": cents(offer["extra_period_price"]),
            "c": 1 if custom else 0,
            "def": int(offer["devices"] or 0) or 1,
        }
    single_rows = "".join(
        hotspot_pick(offer, mode == "one" and index == 0, False) for index, offer in enumerate(single)
    )
    multi_rows = "".join(
        hotspot_pick(offer, mode == "multi" and index == 0, not int(offer["devices"] or 0))
        for index, offer in enumerate(multi)
    )
    if not offers:
        picker = """<p class=note>No hotspot packages are on sale for this router yet. The provider adds them under Packages → Hotspot.</p>"""
    else:
        tabs = f"""<div class=tabs>
<button type=button id=tabone class="tab{' on' if mode == 'one' else ''}" onclick="pick_mode('one')">One device</button>
<button type=button id=tabmulti class="tab{' on' if mode == 'multi' else ''}" onclick="pick_mode('multi')">Multiple devices</button>
</div>"""
        picker = f"""{tabs}
<div id="list-one"{'' if mode == 'one' else ' style="display:none"'}>{single_rows or '<p class=note>No single-device packages are on sale — try a multiple-device option.</p>'}</div>
<div id="list-multi"{'' if mode == 'multi' else ' style="display:none"'}>{multi_rows or '<p class=note>No multiple-device packages are on sale — pick a single-device bundle.</p>'}</div>"""
    site = esc(f"{device['name']} · {device['site']}".strip(" ·"))
    lead = f"You're connected to <b>{site}</b>. " if site else ""
    stk = ""
    if payment:
        stk = """
<p class=sect>Pay with M-Pesa</p>
<label for=phone>M-Pesa phone number</label>
<input id=phone inputmode=tel autocomplete=tel placeholder="0712 345 678">
<button id=paybtn type=button onclick="pay()">Pay with M-Pesa</button>
<div id=msg aria-live=polite></div>
<p class=hint>You will get a prompt on the phone to approve. The page updates itself when the payment lands and your internet switches on.</p>"""
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
    script = f"""<script>
const CTX={ctx_json};
const BRAND={json.dumps(BRAND)};
const DONE={json.dumps(DONE_ICON)};
const WARNI={json.dumps(WARN_ICON)};
const PKG={json.dumps(pkg_js)};
const SIG={json.dumps(hotspot_signature(offers, payment))};
let MODE='{mode}';
let cid=null;
function money(cents){{return 'KSh '+(cents%100?(cents/100).toFixed(2):String(cents/100));}}
function msg(html,ok){{document.getElementById('msg').innerHTML='<div class='+(ok?'ok':'note')+'>'+html+'</div>';}}
function err(text){{document.getElementById('msg').innerHTML='<div class=err>'+text+'</div>';}}
function sel(){{const list=document.getElementById(MODE==='one'?'list-one':'list-multi');const p=list?list.querySelector('input[name=pkg]:checked'):null;return p?p.value:'';}}
function num(id){{const e=document.getElementById(id);return e?e.value:'';}}
function quote(){{
 const id=sel();const p=PKG[id];
 if(!p)return{{devices:1,periods:1,total:0}};
 if(MODE==='one')return{{devices:1,periods:1,total:p.b}};
 if(!p.c)return{{devices:p.def,periods:1,total:p.b}};
 const dv=parseInt(num('dev-'+id),10);const pr=parseInt(num('per-'+id),10);
 const d=isNaN(dv)?1:Math.min(50,Math.max(1,dv));
 const n=isNaN(pr)?1:Math.min(60,Math.max(1,pr));
 return{{devices:d,periods:n,total:p.b+(d-1)*p.d+(n-1)*p.p}};
}}
function refresh(){{
 document.querySelectorAll('.cust').forEach(function(c){{c.style.display='none';}});
 const id=sel();const q=quote();
 if(id&&MODE==='multi'){{const c=document.getElementById('cust-'+id);if(c)c.style.display='block';}}
 if(id){{const t=document.getElementById('tot-'+id);if(t)t.textContent=money(q.total);}}
 const b=document.getElementById('paybtn');if(b)b.textContent='Pay '+money(q.total)+' with M-Pesa';
 document.querySelectorAll('.pick').forEach(function(x){{const r=x.querySelector('input[name=pkg]');x.classList.toggle('on',!!(r&&r.checked));}});
}}
function pick_mode(m){{
 MODE=m;
 const one=document.getElementById('list-one');const multi=document.getElementById('list-multi');
 if(one)one.style.display=m==='one'?'':'none';
 if(multi)multi.style.display=m==='one'?'none':'';
 const t1=document.getElementById('tabone');const t2=document.getElementById('tabmulti');
 if(t1)t1.className='tab'+(m==='one'?' on':'');
 if(t2)t2.className='tab'+(m==='one'?'':' on');
 const list=document.getElementById(m==='one'?'list-one':'list-multi');
 if(list&&!list.querySelector('input[name=pkg]:checked')){{const r=list.querySelector('input[name=pkg]');if(r)r.checked=true;}}
 refresh();
}}
async function poll(){{
 if(!cid)return;
 const r=await fetch('/hotspot/status?id='+encodeURIComponent(cid));
 const b=await r.json();
 if(b.state==='paid'){{cid=null;paid(b);return;}}
 if(b.state==='failed'){{cid=null;err(b.reason||'Payment was not completed.');const btn=document.getElementById('paybtn');if(btn)btn.disabled=false;refresh();return;}}
 setTimeout(poll,2500);
}}
let paidBody=null;
function vlist(b){{
 if(!b.vouchers||!b.vouchers.length)return '';
 let h='<div class=creds>Voucher'+(b.vouchers.length>1?'s':'')+' for this purchase — enter a code under "Have a voucher?" to connect another device:<br>';
 b.vouchers.forEach(function(v){{h+='<b>'+v.code+'</b> <i>('+(v.status==='used'?'used':'ready')+')</i><br>';}});
 return h+'</div>';
}}
function copycodes(){{
 const codes=[].map.call(document.querySelectorAll('.creds b'),function(x){{return x.textContent;}}).join('  ');
 const done=function(){{const c=document.getElementById('copied');if(c)c.textContent='Copied — paste them somewhere safe.';}};
 if(navigator.clipboard&&navigator.clipboard.writeText){{navigator.clipboard.writeText(codes).then(done,function(){{legacy(codes);done();}});return;}}
 legacy(codes);done();
}}
function legacy(t){{
 const ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';
 document.body.appendChild(ta);ta.select();
 try{{document.execCommand('copy');}}catch(e){{}}
 document.body.removeChild(ta);
}}
function go(){{
 const b=paidBody||{{}};
 if(b.loginUrl){{location.href=b.loginUrl;return;}}
 if(b.purchase){{location.href='/thank-you?purchase='+encodeURIComponent(b.purchase);return;}}
}}
function paid(b){{
 paidBody=b;
 const card=document.querySelector('.card');
 let html='<div class=okpage>';
 if(b.warning)html+=WARNI+'<span class="badge warn">Received</span><h1>Payment received</h1><p class=sub>'+b.warning+'</p>';
 else html+=DONE+'<span class="badge ok">Paid</span><h1>You are online</h1><p class=sub>Internet is switched on for this device.</p>';
 html+=vlist(b);
 if(b.vouchers&&b.vouchers.length){{
  html+='<p class=note>Copy these codes before leaving — each connects one device and cannot be used twice.</p>';
  html+='<button type=button onclick="copycodes()">Copy voucher code'+(b.vouchers.length>1?'s':'')+'</button>';
  html+='<p class=hint id=copied></p>';
 }}
 html+='<button type=button onclick="go()">Done — continue</button></div>';
 card.innerHTML=BRAND+html;
}}
async function redeem(){{
 const code=document.getElementById('vcode').value.trim();
 const rmsg=document.getElementById('rmsg');
 if(!code){{rmsg.innerHTML='<div class=err>Enter the voucher code.</div>';return;}}
 const btn=document.getElementById('redeembtn');
 btn.disabled=true;btn.textContent='Connecting…';
 rmsg.innerHTML='<div class=note>Connecting this device…</div>';
 try{{
  const r=await fetch('/hotspot/redeem',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{device:CTX.device,ip:CTX.ip,mac:CTX.mac,code:code}})}});
  const b=await r.json();
  if(b.state==='connected'){{location.href='/thank-you?purchase='+encodeURIComponent(b.purchase);return;}}
  rmsg.innerHTML='<div class=err>'+(b.error||'That voucher could not be used.')+'</div>';
 }}catch(e){{rmsg.innerHTML='<div class=err>Could not reach the router — try again.</div>';}}
 btn.disabled=false;btn.textContent='Connect';
}}
async function pay(){{
 const pkg=sel();
 if(!pkg){{err('Pick a package first.');return;}}
 const phone=document.getElementById('phone').value.trim();
 if(!phone){{err('Enter the M-Pesa number that should approve the payment.');return;}}
 const btn=document.getElementById('paybtn');
 const q=quote();
 const r=await fetch('/hotspot/pay',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{device:CTX.device,ip:CTX.ip,mac:CTX.mac,login:CTX.login,orig:CTX.orig,packageId:pkg,phone:phone,devices:q.devices,periods:q.periods}})}});
 const b=await r.json();
 if(b.checkoutId){{cid=b.checkoutId;btn.disabled=true;btn.textContent='Waiting for M-Pesa approval…';msg('Check the phone and approve the M-Pesa prompt…');poll();}}
 else err(b.error||'Could not start the payment.');
}}
document.querySelectorAll('input[name=pkg]').forEach(function(r){{r.addEventListener('change',refresh);}});
document.querySelectorAll('.cust input').forEach(function(i){{i.addEventListener('input',refresh);}});
function saveState(){{
 try{{
  sessionStorage.setItem('hsForm',JSON.stringify({{m:MODE,p:sel(),ph:(document.getElementById('phone')||{{}}).value||''}}));
 }}catch(e){{}}
}}
async function fresh(){{
 if(cid)return;
 try{{
  const r=await fetch('/hotspot/offers?d='+encodeURIComponent(CTX.device));const b=await r.json();
  if(!b.sig||b.state!=='sale'||b.sig!==SIG){{saveState();location.reload();}}
 }}catch(e){{}}
}}
try{{
 const s=JSON.parse(sessionStorage.getItem('hsForm')||'null');
 if(s){{sessionStorage.removeItem('hsForm');
  if(s.m&&s.m!==MODE)pick_mode(s.m);
  const inp=document.querySelector('input[name=pkg][value="'+s.p+'"]');if(inp)inp.checked=true;
  const ph=document.getElementById('phone');if(ph&&s.ph)ph.value=s.ph;
 }}
}}catch(e){{}}
setInterval(fresh,15000);
document.addEventListener('visibilitychange',function(){{if(!document.hidden)fresh();}});
refresh();
</script>"""
    redeem = """
<p class=sect>Have a voucher?</p>
<div class=redeem>
<input id=vcode placeholder="XXXX-XXXX-XXXX" autocomplete=off spellcheck=false>
<button id=redeembtn type=button onclick="redeem()">Connect</button>
</div>
<div id=rmsg aria-live=polite></div>"""
    body = f"""<span class="ic blue">{ICON_WIFI}</span>
<span class="badge blue">Wi-Fi hotspot</span>
<h1>Choose a bundle to get online</h1>
<p class=sub>{lead}Pick a bundle and pay — your internet switches on as soon as M-Pesa confirms.</p>
<p class=sect>Wi-Fi bundles</p>
{picker}
{stk}
{redeem}
{script}"""
    return page("Get online", body).replace(b"</style>", HOTSPOT_CSS.encode() + b"</style>")


def hotspot_pending_for(cursor, checkout_id):
    """Load a purchase with the router and package details needed to finish it."""
    cursor.execute(
        """
        SELECT pu.id AS purchase_id, pu.client_id, pu.device_id, pu.mac, pu.ip, pu.devices, pu.periods,
               pu.status, pu.username, pu.password, pu.login_url, pu.orig_url, pu.paid_at, pu.created_at, pu.mpesa_code,
               d.tunnel_ip, d.api_secret,
               COALESCE(p.download_mbps, c.download_mbps, 0) AS download_mbps,
               COALESCE(p.upload_mbps, c.upload_mbps, 0) AS upload_mbps,
               COALESCE(p.validity_amount, c.validity_amount, 1) AS validity_amount,
               COALESCE(p.validity_unit, c.validity_unit, 'days') AS validity_unit,
               pu.package_id
        FROM hotspot_purchases pu
        LEFT JOIN isp_mikrotik_devices d ON d.id = pu.device_id
        LEFT JOIN isp_packages p ON p.id = pu.package_id
        LEFT JOIN company_packages c ON c.id = p.company_package_id
        WHERE pu.checkout_id = %s
        """,
        (checkout_id,),
    )
    return cursor.fetchone()


def hotspot_pending_from_row(row):
    """Rebuild the in-memory pending entry so a restart cannot strand a payment."""
    return {
        "purchase_id": row["purchase_id"],
        "client_id": row["client_id"],
        "device_id": row.get("device_id") or "",
        "tunnel_ip": row.get("tunnel_ip") or "",
        "api_secret": row.get("api_secret") or "",
        "package_id": row["package_id"],
        "download": int(row["download_mbps"] or 0),
        "upload": int(row["upload_mbps"] or 0),
        "seconds": int(row["periods"] or 1) * validity_seconds(row["validity_amount"], row["validity_unit"]),
        "devices": int(row["devices"] or 1),
        "ip": row["ip"],
        "mac": row["mac"],
        "login": row.get("login_url") or "",
        "orig": row.get("orig_url") or "",
        "at": row.get("created_at") or datetime.now(),
    }


def hotspot_login_url(pending, username, password, dst=""):
    login = str(pending.get("login") or "")
    if not login.startswith("http"):
        return ""
    separator = "&" if "?" in login else "?"
    url = f"{login}{separator}username={quote(username, safe='')}&password={quote(password, safe='')}"
    orig = str(dst or pending.get("orig") or "")
    if orig.startswith("http"):
        url += f"&dst={quote(orig, safe='')}"
    return url


def thankyou_url(purchase_id):
    return f"{portal_base()}/thank-you?purchase={quote(str(purchase_id), safe='')}"


def normalize_voucher_code(value):
    """Accept a voucher code typed with or without dashes, in any case."""
    raw = re.sub(r"[^A-Za-z0-9]", "", str(value or "")).upper()
    if len(raw) != 12:
        return raw
    return "-".join((raw[:4], raw[4:8], raw[8:12]))


def issue_hotspot_vouchers(cursor, pending):
    """One single-use voucher per paid device slot; idempotent per purchase."""
    cursor.execute(
        "SELECT id, code, username, password, status FROM hotspot_vouchers WHERE purchase_id = %s ORDER BY issued_at, id",
        (pending["purchase_id"],),
    )
    existing = cursor.fetchall()
    if existing:
        return existing
    rows = []
    for _slot in range(max(1, int(pending.get("devices") or 1))):
        code = pppoe_store.voucher_code()
        for _attempt in range(5):
            cursor.execute("SELECT id FROM hotspot_vouchers WHERE code = %s", (code,))
            if not cursor.fetchone():
                break
            code = pppoe_store.voucher_code()
        voucher_id = str(uuid.uuid4())
        username = f"hs-{secrets.token_hex(4)}"
        secret = secrets.token_hex(4)
        cursor.execute(
            """
            INSERT INTO hotspot_vouchers
              (id, client_id, purchase_id, device_id, package_id, code, username, password, seconds)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                voucher_id,
                pending["client_id"],
                pending["purchase_id"],
                str(pending.get("device_id") or "")[:36],
                str(pending.get("package_id") or "")[:36],
                code,
                username,
                secret,
                int(pending.get("seconds") or 0),
            ),
        )
        rows.append({"id": voucher_id, "code": code, "username": username, "password": secret, "status": "issued"})
    return rows


def hotspot_voucher_list(cursor, purchase_id):
    cursor.execute(
        "SELECT code, status FROM hotspot_vouchers WHERE purchase_id = %s ORDER BY issued_at, id",
        (purchase_id,),
    )
    return cursor.fetchall()


def hotspot_receipt(cursor, purchase_id):
    """Thank-you receipt for a hotspot purchase with all of its vouchers."""
    cursor.execute(
        """
        SELECT pu.id, pu.amount, pu.devices,
               COALESCE(p.name, c.name, 'Wi-Fi bundle') AS package_name
        FROM hotspot_purchases pu
        LEFT JOIN isp_packages p ON p.id = pu.package_id
        LEFT JOIN company_packages c ON c.id = p.company_package_id
        WHERE pu.id = %s
        """,
        (str(purchase_id or "")[:36],),
    )
    row = cursor.fetchone()
    if not row:
        return None
    row["vouchers"] = hotspot_voucher_list(cursor, row["id"])
    return row


def hotspot_paid_result(cursor, row):
    """Credentials for a paid purchase, or pending while they are still being issued."""
    vouchers = [{"code": voucher["code"], "status": voucher["status"]} for voucher in hotspot_voucher_list(cursor, row["purchase_id"])]
    if not row["username"]:
        paid_at = row.get("paid_at")
        if paid_at and (datetime.now() - paid_at).total_seconds() < 60:
            return {"state": "pending"}
        return {
            "state": "paid",
            "purchase": row["purchase_id"],
            "vouchers": vouchers,
            "username": "",
            "password": "",
            "warning": "Payment was received but the router did not answer. Show this page to the provider.",
        }
    body = {
        "state": "paid",
        "purchase": row["purchase_id"],
        "vouchers": vouchers,
        "username": row["username"],
        "password": row["password"] or "",
    }
    login_url = hotspot_login_url(
        {"login": row.get("login_url"), "orig": row.get("orig_url")},
        body["username"],
        body["password"],
        thankyou_url(row["purchase_id"]),
    )
    if login_url:
        body["loginUrl"] = login_url
    return body


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
        if path in ANDROID_PROBES:
            # Android's connectivity check expects a bare 204. Serving the
            # portal page first makes the phone flag a captive portal and
            # raise the "Sign in" popup; after PROBE_GRACE we answer 204 so
            # the network validates and the "limited connection" label clears.
            # The window reopens once a device goes quiet for PROBE_RESTART.
            now = time.time()
            ip = self.client_address[0]
            with PROBE_LOCK:
                first, last = PROBE_SEEN.get(ip, (now, 0.0))
                if now - last > PROBE_RESTART:
                    first = now
                PROBE_SEEN[ip] = (first, now)
                if len(PROBE_SEEN) > 8192:
                    PROBE_SEEN.clear()
            if now - first >= PROBE_GRACE:
                return self._send(b"", 204)
        if path == "/pay/offers":
            return self.pay_offers()
        if path == "/pay/status":
            return self.pay_status(parse_qs(urlparse(self.path).query).get("id", [""])[0])
        if path == "/pay/online":
            return self.pay_online(parse_qs(urlparse(self.path).query).get("id", [""])[0])
        if path == "/help":
            return self._send(help_page())
        if path == "/thank-you":
            return self.thank_you(parse_qs(urlparse(self.path).query))
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
                offers = pppoe_offers(cursor, row)
        finally:
            db.close()
        self._send(pay_page(row, offers, payment))

    def hotspot_get(self, path, query):
        if path.startswith("/hotspot-page/"):
            body = router_page(path.removeprefix("/hotspot-page/"))
            if body is None:
                return self._send(b"not found", 404, "text/plain")
            return self._send(body)
        if path == "/hotspot/status":
            return self.hotspot_status(query.get("id", [""])[0])
        if path == "/hotspot/offers":
            return self.hotspot_offers(query)
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
                            f"""<span class="ic amber">{ICON_ALERT}</span>
<span class="badge warn">Wi-Fi</span>
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
        if urlparse(self.path).path == "/hotspot/redeem":
            return self.hotspot_redeem()
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
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                offers = pppoe_offers(cursor, row)
                offer = next(
                    (item for item in offers if str(item["id"]) == str(payload.get("packageId") or "")),
                    None,
                )
                settings = daraja_settings(cursor, row["client_id"])
        finally:
            db.close()
        if not offer:
            return self._send(b'{"error":"Pick a package that is on sale."}', 400, "application/json")
        price = Decimal(offer["price"] or 0)
        if price <= 0:
            return self._send(b'{"error":"That package has no price set."}', 400, "application/json")
        try:
            amount = Decimal(str(payload.get("amount") or "")).quantize(Decimal("0.01"))
        except InvalidOperation:
            return self._send(b'{"error":"Enter the amount to recharge."}', 400, "application/json")
        if amount <= 0 or amount > Decimal("99999999.99"):
            return self._send(b'{"error":"Enter the amount to recharge."}', 400, "application/json")
        if not settings or not settings["passkey"]:
            return self._send(b'{"error":"M-Pesa prompts are not configured yet."}', 503, "application/json")
        amount = whole_shillings(amount)
        try:
            result = stk_push(settings, phone, amount, row["pppoe_username"])
        except Exception as error:
            return self._send(json.dumps({"error": f"M-Pesa could not start the payment: {error}"}).encode(), 502, "application/json")
        checkout = result.get("CheckoutRequestID")
        if str(result.get("ResponseCode")) != "0" or not checkout:
            return self._send(json.dumps({"error": result.get("errorMessage") or result.get("CustomerMessage") or "M-Pesa rejected the request."}).encode(), 502, "application/json")
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO pppoe_stk_requests
                      (id, client_id, subscriber_id, package_id, package_price, amount, phone, checkout_id, status)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'pending')
                    """,
                    (
                        str(uuid.uuid4()),
                        row["client_id"],
                        row["subscriber_id"],
                        str(offer["id"]),
                        format(price, ".2f"),
                        format(Decimal(amount), ".2f"),
                        phone,
                        checkout,
                    ),
                )
            db.commit()
        except Exception:
            db.rollback()
            return self._send(b'{"error":"The payment started but could not be tracked. Check M-Pesa before retrying."}', 502, "application/json")
        finally:
            db.close()
        self._send(json.dumps({"checkoutId": checkout}).encode(), 200, "application/json")

    def paid_body(self, cursor, db, request):
        """Paid-state response carrying the single-use voucher for this payment."""
        body = {"state": "paid"}
        try:
            voucher = pppoe_store.issue_voucher(
                cursor,
                request["client_id"],
                request["subscriber_id"],
                {
                    "checkoutId": request["checkout_id"],
                    "stkRequestId": request["id"],
                    "packageId": request["package_id"],
                    "packageName": request.get("package_name") or "",
                    "amount": format(request["amount"], ".2f"),
                },
            )
            db.commit()
            body["voucher"] = voucher["code"]
        except Exception:
            db.rollback()
        return json.dumps(body).encode()

    def thank_you(self, query):
        code = query.get("code", [""])[0]
        purchase = query.get("purchase", [""])[0]
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                receipt = hotspot_receipt(cursor, purchase) if purchase else None
                voucher = pppoe_store.voucher_detail(cursor, code) if code else None
        finally:
            db.close()
        if purchase:
            return self._send(thankyou_hotspot_page(receipt))
        return self._send(thankyou_page(voucher))

    def pay_offers(self):
        """Fresh offer fingerprint for an open pay page — the page reloads
        itself when this differs from what it rendered."""
        row = self._subscriber()
        if not row:
            return self._send(b'{"state":"unknown"}', 200, "application/json")
        if row["status"] == "suspended":
            return self._send(b'{"state":"paused"}', 200, "application/json")
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                payment = daraja_settings(cursor, row["client_id"])
                offers = pppoe_offers(cursor, row)
        finally:
            db.close()
        body = json.dumps({"state": "sale", "sig": pay_signature(row, offers, payment)}).encode()
        return self._send(body, 200, "application/json")

    def pay_status(self, checkout_id):
        """Poll Daraja, then credit the subscriber exactly once per paid request."""
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT r.id, r.client_id, r.subscriber_id, r.package_id, r.package_price,
                           r.amount, r.checkout_id, r.mpesa_code, r.status, r.last_error, r.created_at,
                           p.name AS package_name
                    FROM pppoe_stk_requests r
                    LEFT JOIN isp_packages p ON p.id = r.package_id
                    WHERE r.checkout_id = %s
                    """,
                    (checkout_id,),
                )
                request = cursor.fetchone()
                if not request:
                    return self._send(b'{"state":"failed","reason":"Unknown or expired payment request."}', 200, "application/json")
                if request["status"] == "paid":
                    return self._send(self.paid_body(cursor, db, request), 200, "application/json")
                if request["status"] == "processing":
                    return self._send(b'{"state":"pending"}', 200, "application/json")
                confirmed = bool(str(request.get("mpesa_code") or "").strip())
                if request["status"] == "failed" and not confirmed:
                    reason = request["last_error"] or "Payment was declined."
                    return self._send(json.dumps({"state": "failed", "reason": reason}).encode(), 200, "application/json")
                # A Daraja callback that already wrote the M-Pesa receipt confirms
                # the payment without another stkpushquery round-trip — even when an
                # earlier poll marked the request failed before the PIN was entered.
                if not confirmed:
                    settings = daraja_settings(cursor, request["client_id"])
                    result = None
                    if settings:
                        try:
                            result = stk_query(settings, checkout_id)
                        except Exception:
                            result = None
                    stale = (datetime.now() - request["created_at"]).total_seconds() > 180
                    if result is None:
                        if stale:
                            return self._send(b'{"state":"failed","reason":"The prompt expired. Try again."}', 200, "application/json")
                        return self._send(b'{"state":"pending"}', 200, "application/json")
                    state, reason = stk_state(result)
                    if state != "paid":
                        # stkpushquery reports interim codes like 1037 while the
                        # prompt is still open — only the callback (or the expiry
                        # window) may fail the request, never the query alone.
                        if stale:
                            reason = reason or "The prompt expired. Try again."
                            cursor.execute(
                                "UPDATE pppoe_stk_requests SET status = 'failed', last_error = %s WHERE checkout_id = %s AND status = 'pending'",
                                (reason[:255], checkout_id),
                            )
                            db.commit()
                            return self._send(json.dumps({"state": "failed", "reason": reason}).encode(), 200, "application/json")
                        return self._send(b'{"state":"pending"}', 200, "application/json")
                cursor.execute(
                    "UPDATE pppoe_stk_requests SET status = 'processing' WHERE checkout_id = %s AND (status = 'pending' OR (status = 'failed' AND mpesa_code <> ''))",
                    (checkout_id,),
                )
                db.commit()
                if cursor.rowcount == 0:
                    cursor.execute("SELECT status FROM pppoe_stk_requests WHERE checkout_id = %s", (checkout_id,))
                    claimed = (cursor.fetchone() or {}).get("status")
                    if claimed == "paid":
                        return self._send(self.paid_body(cursor, db, request), 200, "application/json")
                    return self._send(b'{"state":"pending"}', 200, "application/json")
                try:
                    cursor.execute(
                        "SELECT package_id FROM pppoe_subscribers WHERE id = %s",
                        (request["subscriber_id"],),
                    )
                    current = cursor.fetchone()
                    if request.get("package_id") and current and str(request["package_id"]) != str(current["package_id"]):
                        cursor.execute(
                            "UPDATE pppoe_subscribers SET package_id = %s WHERE id = %s",
                            (request["package_id"], request["subscriber_id"]),
                        )
                        cursor.execute(
                            "UPDATE pppoe_subscriptions SET package_id = %s, price = %s WHERE subscriber_id = %s",
                            (request["package_id"], request["package_price"], request["subscriber_id"]),
                        )
                    pppoe_store.renew(
                        cursor,
                        request["client_id"],
                        request["subscriber_id"],
                        {
                            "amount": format(request["amount"], ".2f"),
                            "mpesaReference": (request.get("mpesa_code") or checkout_id)[:40],
                        },
                    )
                    cursor.execute(
                        "UPDATE pppoe_stk_requests SET status = 'paid', paid_at = NOW() WHERE checkout_id = %s",
                        (checkout_id,),
                    )
                    db.commit()
                except pppoe_store.PppoeError as error:
                    # A validation failure (amount too small, no package price)
                    # never succeeds on retry — end the request instead of
                    # bouncing it back to pending forever.
                    db.rollback()
                    reason = str(error)
                    if confirmed:
                        reason += " The payment was received — contact the provider to apply it."
                    try:
                        cursor.execute(
                            "UPDATE pppoe_stk_requests SET status = 'failed', last_error = %s WHERE checkout_id = %s",
                            (reason[:255], checkout_id),
                        )
                        db.commit()
                    except Exception:
                        db.rollback()
                    return self._send(json.dumps({"state": "failed", "reason": reason}).encode(), 200, "application/json")
                except Exception as error:
                    db.rollback()
                    try:
                        cursor.execute(
                            "UPDATE pppoe_stk_requests SET status = 'pending', last_error = %s WHERE checkout_id = %s",
                            (str(error)[:255], checkout_id),
                        )
                        db.commit()
                    except Exception:
                        db.rollback()
                    return self._send(b'{"state":"pending"}', 200, "application/json")
                return self._send(self.paid_body(cursor, db, request), 200, "application/json")
        finally:
            db.close()

    def pay_online(self, checkout_id):
        """Whether the paid subscriber has re-dialed since the payment landed.

        renewal sends a Disconnect-Request, so the old session closes and a fresh
        radacct session opens with acctstarttime after paid_at — only that counts
        as back online; a pre-payment session would still be in redirect."""
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT r.status, r.paid_at, r.created_at, s.pppoe_username
                    FROM pppoe_stk_requests r
                    JOIN pppoe_subscribers s ON s.id = r.subscriber_id
                    WHERE r.checkout_id = %s
                    """,
                    (checkout_id,),
                )
                request = cursor.fetchone()
                if not request or request["status"] != "paid":
                    return self._send(b'{"state":"connecting"}', 200, "application/json")
                cursor.execute(
                    """
                    SELECT 1 FROM radacct
                    WHERE username = %s AND acctstoptime IS NULL
                      AND acctstarttime >= %s - INTERVAL 5 SECOND
                    LIMIT 1
                    """,
                    (request["pppoe_username"], request["paid_at"] or request["created_at"]),
                )
                state = "online" if cursor.fetchone() else "connecting"
                return self._send(json.dumps({"state": state}).encode(), 200, "application/json")
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
                quote_result = hotspot_quote(package, payload)
                if not quote_result:
                    return self._send(
                        b'{"error":"Choose between 1 and 50 devices and 1 and 60 periods."}',
                        400,
                        "application/json",
                    )
                settings = daraja_settings(cursor, device["client_id"])
        finally:
            db.close()
        if not settings or not settings["passkey"]:
            return self._send(b'{"error":"M-Pesa prompts are not configured yet."}', 503, "application/json")
        phone = normalize_phone(payload.get("phone"))
        if not phone:
            return self._send(b'{"error":"Enter a valid Safaricom number, like 0712345678."}', 400, "application/json")
        charged = whole_shillings(quote_result["amount"])
        try:
            result = stk_push(settings, phone, charged, str(package["name"] or "Hotspot")[:12])
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
                    INSERT INTO hotspot_purchases (id, client_id, device_id, package_id, phone, amount, checkout_id, mac, ip, devices, periods, login_url, orig_url, status)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending')
                    """,
                    (
                        purchase_id,
                        device["client_id"],
                        device["id"],
                        package["id"],
                        phone,
                        format(Decimal(charged), ".2f"),
                        checkout,
                        mac,
                        ip,
                        quote_result["devices"],
                        quote_result["periods"],
                        str(payload.get("login") or "")[:255],
                        str(payload.get("orig") or "")[:255],
                    ),
                )
            db.commit()
        finally:
            db.close()
        with HOTSPOT_LOCK:
            HOTSPOT_PENDING[checkout] = {
                "purchase_id": purchase_id,
                "client_id": device["client_id"],
                "device_id": device["id"],
                "tunnel_ip": device["tunnel_ip"],
                "api_secret": device["api_secret"],
                "package_id": package["id"],
                "download": int(package["download_mbps"]),
                "upload": int(package["upload_mbps"]),
                "seconds": quote_result["seconds"],
                "devices": quote_result["devices"],
                "ip": ip,
                "mac": mac,
                "login": str(payload.get("login") or "")[:200],
                "orig": str(payload.get("orig") or "")[:200],
                "at": datetime.now(),
            }
        self._send(json.dumps({"checkoutId": checkout}).encode(), 200, "application/json")

    def hotspot_authorize(self, pending, voucher=None):
        if not pending.get("api_secret"):
            raise RuntimeError("the router has no saved API access")
        password = routeros_api.open_password(pending["api_secret"])
        username = (voucher or {}).get("username") or f"hs-{secrets.token_hex(4)}"
        secret = (voucher or {}).get("password") or secrets.token_hex(4)
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
            1,
            f"{pending['seconds']}s",
        )
        return {"username": username, "password": secret, "authorized": True, "online": bool(report.get("online"))}

    def hotspot_offers(self, query):
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                device = hotspot_device(cursor, self.client_address[0], query.get("d", [""])[0])
                if not device:
                    return self._send(b'{"state":"unknown"}', 200, "application/json")
                offers = hotspot_packages(cursor, device["client_id"], device["id"])
                payment = daraja_settings(cursor, device["client_id"])
        finally:
            db.close()
        body = json.dumps({"state": "sale", "sig": hotspot_signature(offers, payment)}).encode()
        return self._send(body, 200, "application/json")

    def hotspot_status(self, checkout_id):
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                # Read the row on every poll so a Daraja callback that already
                # landed resolves immediately instead of waiting on stkpushquery.
                row = hotspot_pending_for(cursor, checkout_id)
                if not row:
                    return self._send(b'{"state":"failed","reason":"Unknown or expired payment request."}', 200, "application/json")
                if row["status"] == "paid":
                    try:
                        late = issue_hotspot_vouchers(cursor, hotspot_pending_from_row(row))
                        if late and row["username"]:
                            cursor.execute(
                                "UPDATE hotspot_vouchers SET status = 'used', used_at = NOW() WHERE id = %s AND status = 'issued'",
                                (late[0]["id"],),
                            )
                        db.commit()
                    except Exception:
                        db.rollback()
                    return self._send(json.dumps(hotspot_paid_result(cursor, row)).encode(), 200, "application/json")
                confirmed = bool(str(row.get("mpesa_code") or "").strip())
                if row["status"] == "failed" and not confirmed:
                    return self._send(b'{"state":"failed","reason":"Payment was declined."}', 200, "application/json")
                with HOTSPOT_LOCK:
                    pending = HOTSPOT_PENDING.get(checkout_id)
                if not pending:
                    pending = hotspot_pending_from_row(row)
                    with HOTSPOT_LOCK:
                        HOTSPOT_PENDING[checkout_id] = pending
                if not confirmed and (datetime.now() - pending["at"]).total_seconds() > 180:
                    with HOTSPOT_LOCK:
                        HOTSPOT_PENDING.pop(checkout_id, None)
                    return self._send(b'{"state":"failed","reason":"The prompt expired. Try again."}', 200, "application/json")
                if confirmed:
                    # The Daraja callback already confirmed this purchase.
                    state, reason = "paid", ""
                else:
                    settings = daraja_settings(cursor, pending["client_id"])
                    if not settings:
                        return self._send(b'{"state":"pending"}', 200, "application/json")
                    try:
                        result = stk_query(settings, checkout_id)
                    except Exception:
                        return self._send(b'{"state":"pending"}', 200, "application/json")
                    state, reason = stk_state(result)
                if state == "pending":
                    return self._send(b'{"state":"pending"}', 200, "application/json")
                if state == "failed":
                    # Interim query results (premature 1037 etc.) are not final —
                    # the Daraja callback decides failure. Keep waiting until the
                    # prompt expires rather than stranding a still-open prompt.
                    return self._send(b'{"state":"pending"}', 200, "application/json")
                cursor.execute(
                    "UPDATE hotspot_purchases SET status = 'paid', paid_at = NOW() WHERE checkout_id = %s AND (status = 'pending' OR (status = 'failed' AND mpesa_code <> ''))",
                    (checkout_id,),
                )
                db.commit()
                if cursor.rowcount == 0:
                    row = hotspot_pending_for(cursor, checkout_id)
                    if row and row["status"] == "paid":
                        return self._send(json.dumps(hotspot_paid_result(cursor, row)).encode(), 200, "application/json")
                    return self._send(b'{"state":"pending"}', 200, "application/json")
                vouchers = []
                try:
                    vouchers = issue_hotspot_vouchers(cursor, pending)
                    db.commit()
                except Exception:
                    db.rollback()
                try:
                    grant = self.hotspot_authorize(pending, vouchers[0] if vouchers else None)
                except Exception as error:
                    grant = {"username": "", "password": "", "authorized": False, "error": str(error)}
                if vouchers and grant.get("online"):
                    cursor.execute(
                        """
                        UPDATE hotspot_vouchers
                        SET status = 'used', used_at = NOW(), redeemed_ip = %s, redeemed_mac = %s
                        WHERE id = %s AND status = 'issued'
                        """,
                        (pending["ip"], pending["mac"], vouchers[0]["id"]),
                    )
                    vouchers[0]["status"] = "used"
                cursor.execute(
                    """
                    UPDATE hotspot_purchases
                    SET username = %s, password = %s, authorized = %s
                    WHERE id = %s
                    """,
                    (grant["username"], grant["password"], 1 if grant.get("authorized") else 0, pending["purchase_id"]),
                )
                db.commit()
                with HOTSPOT_LOCK:
                    HOTSPOT_PENDING.pop(checkout_id, None)
                body = {
                    "state": "paid",
                    "purchase": pending["purchase_id"],
                    "username": grant["username"],
                    "password": grant["password"],
                    "vouchers": [{"code": voucher["code"], "status": voucher["status"]} for voucher in vouchers],
                }
                login_url = hotspot_login_url(pending, grant["username"], grant["password"], thankyou_url(pending["purchase_id"]))
                if login_url:
                    body["loginUrl"] = login_url
                if not grant.get("authorized"):
                    body["warning"] = "Payment was received but the router did not answer. Show this page to the provider."
                return self._send(json.dumps(body).encode(), 200, "application/json")
        finally:
            db.close()

    def hotspot_redeem(self):
        """Spend an issued hotspot voucher: create its login and connect this device."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(min(length, 8192)) or b"{}")
        except (ValueError, OSError):
            return self._send(b'{"error":"Bad request."}', 400, "application/json")
        code = normalize_voucher_code(payload.get("code"))
        if not code:
            return self._send(b'{"error":"Enter the voucher code."}', 400, "application/json")
        ip = str(payload.get("ip") or "").strip()[:45]
        mac = str(payload.get("mac") or "").strip().upper()[:20]
        db = self.server.connect()
        try:
            with db.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT v.id, v.client_id, v.purchase_id, v.device_id, v.package_id, v.code,
                           v.username, v.password, v.seconds, v.status,
                           d.tunnel_ip, d.api_secret,
                           COALESCE(p.download_mbps, c.download_mbps, 0) AS download_mbps,
                           COALESCE(p.upload_mbps, c.upload_mbps, 0) AS upload_mbps
                    FROM hotspot_vouchers v
                    JOIN isp_mikrotik_devices d ON d.id = v.device_id
                    LEFT JOIN isp_packages p ON p.id = v.package_id
                    LEFT JOIN company_packages c ON c.id = p.company_package_id
                    WHERE v.code = %s
                    """,
                    (code,),
                )
                voucher = cursor.fetchone()
                if not voucher:
                    return self._send(b'{"error":"That voucher code was not recognised."}', 404, "application/json")
                if voucher["status"] != "issued":
                    return self._send(b'{"error":"That voucher was already used."}', 400, "application/json")
                cursor.execute(
                    """
                    UPDATE hotspot_vouchers
                    SET status = 'used', used_at = NOW(), redeemed_ip = %s, redeemed_mac = %s
                    WHERE id = %s AND status = 'issued'
                    """,
                    (ip, mac, voucher["id"]),
                )
                db.commit()
                if cursor.rowcount == 0:
                    return self._send(b'{"error":"That voucher was already used."}', 400, "application/json")
                try:
                    secret = routeros_api.open_password(voucher["api_secret"] or "")
                    profile = f"hs-{str(voucher['package_id'])[:8]}"
                    rate = f"{int(voucher['upload_mbps'] or 0)}M/{int(voucher['download_mbps'] or 0)}M"
                    routeros_api.authorize_hotspot_client(
                        voucher["tunnel_ip"],
                        secret,
                        ip,
                        mac,
                        voucher["username"],
                        voucher["password"],
                        profile,
                        rate,
                        1,
                        f"{max(1, int(voucher['seconds'] or 0))}s",
                    )
                except Exception:
                    cursor.execute(
                        """
                        UPDATE hotspot_vouchers
                        SET status = 'issued', used_at = NULL, redeemed_ip = '', redeemed_mac = ''
                        WHERE id = %s
                        """,
                        (voucher["id"],),
                    )
                    db.commit()
                    return self._send(
                        b'{"error":"The router did not answer - try again in a moment."}',
                        502,
                        "application/json",
                    )
                return self._send(
                    json.dumps({"state": "connected", "purchase": voucher["purchase_id"]}).encode(),
                    200,
                    "application/json",
                )
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
