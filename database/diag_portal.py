"""Diagnostic: time the portal pay-page queries and check their indexes."""

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import envfile

envfile.load()

import pymysql
from pymysql.cursors import DictCursor

db = pymysql.connect(
    host=os.environ.get("ISP_DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("ISP_DB_PORT", "3306")),
    user=os.environ.get("ISP_DB_USER", "root"),
    password=os.environ.get("ISP_DB_PASSWORD", ""),
    database=os.environ.get("ISP_DB_NAME", "ISP-DB"),
    charset="utf8mb4",
    autocommit=True,
    cursorclass=DictCursor,
)

cur = db.cursor()

def timeit(label, fn, n=3):
    best = None
    for _ in range(n):
        t = time.perf_counter()
        fn()
        ms = (time.perf_counter() - t) * 1000
        best = ms if best is None else min(best, ms)
    print(f"{label:<55} {best:8.1f} ms")

print("== table sizes ==")
for table in ("radacct", "pppoe_subscribers", "pppoe_subscriptions", "isp_packages",
              "pppoe_stk_requests", "hotspot_purchases", "hotspot_vouchers",
              "isp_mikrotik_devices", "isp_payment_settings", "company_packages"):
    try:
        cur.execute(f"SELECT COUNT(*) AS n FROM {table}")
        print(f"{table:<30} {cur.fetchone()['n']:>8}")
    except Exception as e:
        print(f"{table:<30} ERROR {e}")

print("\n== indexes ==")
for table in ("radacct", "pppoe_subscribers", "pppoe_subscriptions",
              "pppoe_stk_requests", "hotspot_purchases", "hotspot_vouchers",
              "isp_mikrotik_devices", "isp_packages"):
    try:
        cur.execute(f"SHOW INDEX FROM {table}")
        keys = sorted({row["Key_name"] for row in cur.fetchall()})
        print(f"{table:<30} {keys}")
    except Exception as e:
        print(f"{table:<30} ERROR {e}")

print("\n== portal query timings ==")

def q_identify():
    cur.execute(
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
        ("10.88.0.99",),
    )
    cur.fetchall()

timeit("identify(framedipaddress, no-session)", q_identify, 5)

def q_packages():
    cur.execute(
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
        ("x",),
    )
    cur.fetchall()

timeit("hotspot_packages(client)", q_packages, 5)

def q_device():
    cur.execute(
        "SELECT id, client_id, name, site, tunnel_ip, api_secret, status FROM isp_mikrotik_devices WHERE tunnel_ip = %s",
        ("10.88.0.5",),
    )
    cur.fetchone()

timeit("hotspot_device(tunnel_ip)", q_device, 5)

def q_daraja():
    cur.execute(
        "SELECT scope, environment, account_type, short_code, consumer_key, consumer_secret, passkey, callback_url FROM isp_payment_settings WHERE client_id = %s",
        ("x",),
    )
    cur.fetchall()

timeit("daraja_settings(client)", q_daraja, 5)

def q_pending():
    cur.execute(
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
        ("none",),
    )
    cur.fetchone()

timeit("hotspot_pending_for(checkout)", q_pending, 5)

def q_stk():
    cur.execute(
        """
        SELECT r.id, r.client_id, r.subscriber_id, r.package_id, r.package_price,
               r.amount, r.checkout_id, r.mpesa_code, r.status, r.last_error, r.created_at,
               p.name AS package_name
        FROM pppoe_stk_requests r
        LEFT JOIN isp_packages p ON p.id = r.package_id
        WHERE r.checkout_id = %s
        """,
        ("none",),
    )
    cur.fetchone()

timeit("pay_status request lookup", q_stk, 5)

def q_online():
    cur.execute(
        """
        SELECT 1 FROM radacct
        WHERE username = %s AND acctstoptime IS NULL
          AND acctstarttime >= %s - INTERVAL 5 SECOND
        LIMIT 1
        """,
        ("nobody", "2020-01-01 00:00:00"),
    )
    cur.fetchone()

timeit("pay_online radacct lookup", q_online, 5)

print("\n== connect() latency ==")
t = time.perf_counter()
conn = pymysql.connect(
    host=os.environ.get("ISP_DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("ISP_DB_PORT", "3306")),
    user=os.environ.get("ISP_DB_USER", "root"),
    password=os.environ.get("ISP_DB_PASSWORD", ""),
    database=os.environ.get("ISP_DB_NAME", "ISP-DB"),
    autocommit=True,
)
print(f"fresh pymysql.connect: {(time.perf_counter()-t)*1000:.1f} ms")
conn.close()

print("\n== EXPLAIN identify ==")
cur.execute(
    """
    EXPLAIN
    SELECT s.id
    FROM radacct r
    JOIN pppoe_subscribers s ON s.pppoe_username = r.username
    WHERE r.framedipaddress = '10.88.0.99' AND r.acctstoptime IS NULL
    ORDER BY r.acctstarttime DESC LIMIT 1
    """
)
for row in cur.fetchall():
    print({k: row[k] for k in ("table", "type", "key", "rows")})

db.close()
