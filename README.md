# ISP CENTRIC

## Running

`python database/api.py` starts everything in one process: the JSON API on
`ISP_API_PORT` (default 8765), the built React app from `frontend/dist`
(`ISP_WEB_ROOT` overrides), the embedded RADIUS listeners, the captive portal,
and the WireGuard management tunnel. On a fresh machine it also creates the
`ISP-DB` database and tables; run `python database/seed.py` once to add the
demo accounts. Configuration lives in `.env` (see `.env.example`) or real
environment variables. To deploy on another machine, follow
[DEPLOYMENT.md](DEPLOYMENT.md).

## PPPoE and RADIUS

PPPoE subscribers are stored in this application's database. Authentication rows are written to the RADIUS SQL tables in the same database: `radcheck`, `radreply`, `radusergroup`, `radgroupreply`, `radacct`, and `nas`.

The API embeds its own RADIUS server (`database/radius_server.py`). When `api.py` starts it binds UDP 1812 (authentication: PAP, CHAP, MS-CHAPv1, MS-CHAPv2) and UDP 1813 (accounting into `radacct`) on all interfaces, so routers at the WireGuard tunnel address `10.88.0.1` are answered directly — no external FreeRADIUS install is required. If the ports are already taken (for example by a real FreeRADIUS pointed at the same tables), the embedded listener logs `bind-failed` and steps aside. Allow inbound UDP 1812 and 1813 to `python.exe` in Windows Firewall.

Point every MikroTik at that RADIUS server. On the router:

```
/radius add address=<radius-host> secret=<secret> service=ppp
/radius incoming set accept=yes
/ppp aaa set use-radius=yes accounting=yes interim-update=5m
```

The first time a client is registered on a router, the registration response includes the shared secret once. The same value is stored sealed in `isp_radius_nas` for this app's own use, while `nas.secret` holds the plaintext secret the RADIUS server needs to verify requests — restrict the database user accordingly.

Every subscriber keeps working credentials, so each account can dial. Subscribers inside an active subscription land in the `pppoe-subscribed` address list with the package `Mikrotik-Rate-Limit`. Blocked accounts are split by reason at a 64k/64k cap: `suspended` lands in `pppoe-suspended` (paused notice), while pending, expired, disconnected, and cancelled accounts land in `pppoe-expired` (recharge portal). Both lists are dropped in the forward chain instead of being deleted.

### Captive portal

The API also runs a walled-garden portal (`database/portal_server.py`) on `ISP_PORTAL_PORT` (default 8790, all interfaces — `ISP_PORTAL_HOST` overrides). The router dst-nats TCP/80 from `pppoe-suspended` and `pppoe-expired` to `10.88.0.1:8790` and lets the two lists reach that host in the forward chain; everything else stays blocked. Suspended visitors see a paused notice; everyone else sees a pay page that auto-identifies them through `radacct`, offers an M-Pesa STK prompt (Daraja creds from ISP payment settings) plus Paybill/Till instructions, and polls `stkpushquery` — an approved payment calls the normal `renew` path, so the session drops and re-authenticates into `pppoe-subscribed` on its own. Because only plain HTTP can be intercepted, HTTPS browsing shows a connection error while blocked; phones and laptops still surface the portal through the OS captive-network check. Allow inbound TCP 8790 to `python.exe` in Windows Firewall.

`Session-Timeout` ends an active session at the expiry cutoff and makes a restricted session re-authenticate every 15 minutes, so status changes apply without waiting for the client to hang up. A disconnect request is also sent to UDP 3799 when a session should drop. If the router does not answer, the account change is still saved and the attempt is reported as queued.

The API runs the activation and expiry sweep for every client every five minutes (`ISP_PPPOE_SWEEP_SECONDS`). `POST /api/pppoe/jobs` and opening the PPPoE client list run the same check for the signed-in ISP account.

### Hotspot pay page

The same portal also serves pay-per-use hotspot guests. A RouterOS hotspot runs on ports configured for `hotspot` use, and on the PPPoE customer port whenever enforcement is off (plain DHCP — the `dhcp-portal` server). Its login page is fetched from the portal (`/hotspot-page/login.html` into the `isp-portal` directory) and simply bounces the guest to `http://10.88.0.1:8790/hotspot`, so the walled garden only needs the portal host, plus a `srcnat` masquerade (`isp-centric-portal-nat`) toward it — blocked PPPoE lists skip that masquerade (`isp-centric-portal-nat-skip`) so the recharge page can still identify them by IP.

On `/hotspot` the guest picks a package whose `service_type` is `hotspot` and pays by STK push. The purchase lands in `hotspot_purchases`; `stkpushquery` polling decides the outcome, and an approved payment creates a hotspot user (`hs-…`, `limit-uptime` from the package validity, `shared-users` from simultaneous devices) and logs the waiting device in through `/ip/hotspot/active/login`. Extra devices on a shared bundle sign in to the hotspot page with the shown username and password.
