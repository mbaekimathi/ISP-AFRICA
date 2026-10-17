# Deploying ISP CENTRIC to the XPS

The whole system runs as **one Python process** plus MySQL and WireGuard.
`api.py` serves the built React app, the JSON API, the embedded RADIUS server,
the captive portal, and the WireGuard management tunnel.

## Components and ports

| Piece                    | Bind default        | Port          |
|--------------------------|---------------------|---------------|
| Web app + JSON API       | `ISP_API_HOST`      | TCP 8765      |
| Captive portal           | `ISP_PORTAL_HOST`   | TCP 8790      |
| RADIUS auth              | all interfaces      | UDP 1812      |
| RADIUS accounting        | all interfaces      | UDP 1813      |
| WireGuard tunnel         | all interfaces      | UDP 51820     |
| MikroTik disconnect (PoD)| —                   | UDP 3799 out  |

## Prereqs on the XPS

1. **Python 3.10+** on PATH (`winget install Python.Python.3.12`).
2. **MySQL 8** running as a service (`winget install Oracle.MySQL`).
   Note the root password — it goes in `.env` as `ISP_DB_PASSWORD`.
3. **WireGuard for Windows** (`winget install WireGuard.WireGuard`) — needed
   for the `C:\Program Files\WireGuard\wireguard.exe` tunnel service.
4. **Node.js 20+ LTS** — only if you build the frontend on the XPS. If you copy
   a ready-made `frontend\dist`, Node is not required at runtime.

## Setup

```powershell
cd C:\isp                      # wherever you copied the project
copy .env.example .env         # then edit .env (DB password, secrets, endpoint)
deploy\setup.ps1               # installs Python deps, builds frontend, creates DB
```

`setup.ps1` runs:

- `pip install -r database\requirements.txt`
- `npm ci && npm run build` in `frontend\` (skipped if npm is absent and `dist` exists)
- `python database\seed.py` — creates `ISP-DB` and the base tables, and prints
  the seeded login codes (`ispclient` / `ispemployee`, password `000000` —
  change them after first sign-in).

`api.py` also creates the database and any missing tables itself on every
start, so re-running seed is only needed for the demo accounts.

## Run

```
deploy\start-isp.cmd
```

`start-isp.cmd` picks a mode — `local` or `prod` — and sets `ISP_ENV`
accordingly (`development` / `production`), which overrides whatever `.env`
says. With no argument it uses the `ISP_ENV` env var if already set, else
`local` when `frontend\node_modules` exists (dev machine) and `prod`
otherwise.

- `deploy\start-isp.cmd local` — development. Starts `api.py` (API on 8765)
  in its own window, then `npm run dev` (Vite on 5173). Open
  `http://localhost:5173` — Vite proxies `/api` to the backend.
- `deploy\start-isp.cmd prod` — production. `api.py` serves the built
  `frontend\dist`; open `http://<xps-address>:8765/`.

On the XPS, `start-isp.cmd` (or simply `python database\api.py`) is all you
need. The first run may pop a UAC prompt so WireGuard can install the
`isp-centric` tunnel service — approve it once.

Open `http://<xps-address>:8765/` for the dashboard. Check
`http://<xps-address>:8765/api/health` — every component should read
`listening`/`running`/`serving`.

## Firewall

Allow inbound on the XPS:

- UDP 51820 (WireGuard — routers dial in here)
- UDP 1812 + 1813 (RADIUS — arrives over the tunnel)
- TCP 8790 (portal — arrives over the tunnel)
- TCP 8765 (web app — only if you manage it from other machines; skip for
  localhost-only `ISP_API_HOST=127.0.0.1`)

`api.py` adds the WireGuard/RADIUS rules itself; add TCP 8765 once:

```powershell
netsh advfirewall firewall add rule name="ISP CENTRIC Web" dir=in action=allow protocol=TCP localport=8765
```

## Pointing routers at the new host

- `ISP_WG_ENDPOINT` must be an address the MikroTiks can reach — the XPS public
  IP/DNS name, or its LAN IP if routers are on-site. UDP 51820 must be
  reachable (port-forward on the edge router if the XPS sits behind NAT).
- The tunnel network stays `10.88.0.0/24`; RADIUS and the portal stay on
  `10.88.0.1`, so router-side config carries over unchanged.

## Moving existing data

To keep the current subscribers, devices, and payment settings:

```powershell
mysqldump -u root -p --databases ISP-DB > isp-backup.sql   # on the dev machine
mysql -u root -p < isp-backup.sql                          # on the XPS
```

Also copy `database\wg\server.key` so routers keep the same server public key;
if you skip it, `api.py` generates a new key and every router must be given
the new `serverPublicKey` shown in the app.

## Autostart (optional)

Task Scheduler → Create Task → Run whether user is logged on or not:

```
Program:  C:\Windows\py.exe   (or your python.exe)
Args:     C:\isp\database\api.py
Start in: C:\isp\database
Trigger:  At startup
```

Or use NSSM (`nssm install ISPCentric "C:\Python312\python.exe" "C:\isp\database\api.py"`).

## Deploying to an Ubuntu VPS

Same single-process design, but WireGuard is driven with `wg-quick` instead of
the Windows tunnel service. `api.py` must run as root (it writes
`/etc/wireguard/isp-centric.conf` and applies peers with `wg syncconf`).

```bash
sudo apt update && sudo apt install -y python3 python3-venv mysql-server \
    wireguard nginx certbot python3-certbot-nginx ufw
sudo mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'STRONG-PASS';"
```

Copy the project to `/opt/isp`, then:

```bash
cd /opt/isp
python3 -m venv venv
venv/bin/pip install -r database/requirements.txt
cp .env.example .env        # edit: ISP_DB_PASSWORD, ISP_WG_ENDPOINT=<vps dns/ip>,
                            # ISP_API_HOST=127.0.0.1 (nginx fronts it), secrets
venv/bin/python database/seed.py
sudo cp deploy/isp-centric.service /etc/systemd/system/
sudo systemctl enable --now isp-centric
```

Firewall (also allow the same ports in the provider's security group):

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw allow 51820/udp && sudo ufw enable
sudo ufw allow in on isp-centric   # RADIUS + portal arrive on the tunnel interface;
                                   # without this ufw silently drops them (api.py
                                   # adds this rule itself once the tunnel is up)
```

Public HTTPS via nginx (`deploy/nginx-site.conf` → `/etc/nginx/sites-available/`):

```bash
sudo ln -s /etc/nginx/sites-available/net.richcom.co.ke /etc/nginx/sites-enabled/
sudo certbot --nginx -d net.richcom.co.ke
```

RADIUS (1812/1813) and the portal (8790) stay on the `10.88.0.0/24` tunnel —
do not expose them publicly.

If the VPS already runs another WireGuard tunnel on UDP 51820 (check with
`sudo wg show`), set `ISP_WG_PORT=51821` in `.env` — `api.py` writes that port
into `isp-centric.conf` and tells routers to dial it — then
`sudo ufw allow 51821/udp`. The two tunnels coexist on separate ports and
separate networks (`10.9.0.0/24` vs `10.88.0.0/24`).

## Updating the VPS

```bash
cd /opt/isp && sudo bash deploy/update-vps.sh
```

It fetches `origin/main`, stashes stray local edits (recover with
`git stash pop`), installs Python deps, rebuilds the frontend only when its
sources changed (Node 20+ needed — the existing `dist/` is kept otherwise),
restarts the service, and prints the health check.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Router RADIUS timeouts; tcpdump shows requests arriving but no replies | ufw drops tunnel traffic. `sudo ufw allow in on isp-centric` (current code adds this automatically). |
| `event=radius … bind-failed` | Another `api.py` (or FreeRADIUS) holds UDP 1812/1813. `netstat -ano | findstr 1812` → kill the PID. Health shows `radius: bind-failed`. |
| `event=wireguard status=waiting-for-admin` | The UAC prompt was denied. Run `api.py` from an elevated shell once. |
| `status=not-installed` | Install WireGuard for Windows on the XPS — or `apt install wireguard` on Linux. |
| `status=needs-root` (Linux) | `api.py` isn't root — WireGuard config needs root. Run via the systemd unit. |
| `status=start-failed` (Linux) | `wg-quick up` failed — check `journalctl -u isp-centric` and `/etc/wireguard/isp-centric.conf`. |
| `/api/health` → `web: not-built` | `frontend\dist` missing — run `npm run build` or copy `dist` over. |
| 404 on every page | `ISP_WEB_ROOT` points at the wrong folder. |
| Daraja 403 / STK fails | Payment settings still on sandbox credentials; set live creds in the app (Payments page). |
| Login fails after copy | MySQL not seeded: `python database\seed.py`. |
