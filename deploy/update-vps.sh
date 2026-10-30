#!/usr/bin/env bash
# update-vps.sh — pull the latest ISP CENTRIC code, rebuild, restart, verify.
#
#   sudo bash deploy/update-vps.sh
#
# Safe to re-run: it fast-forwards only, stashes stray local edits, skips the
# frontend rebuild when nothing changed, and fails loudly if the service does
# not come back healthy.
set -euo pipefail

cd "$(dirname "$0")/.."

# Multi-instance support: source this checkout's .env so ports and the tunnel
# interface match the deployment it belongs to. Override the systemd unit and
# venv for a second instance, e.g.:
#   sudo ISP_SERVICE_NAME=isp-africa bash deploy/update-vps.sh
if [ -f .env ]; then
    set -a
    . ./.env
    set +a
fi

service="${ISP_SERVICE_NAME:-isp-centric}"
venv="${ISP_VENV:-}"
if [ -z "$venv" ]; then
    if [ -x .venv/bin/pip ]; then venv=.venv; else venv=venv; fi
fi
api_port="${ISP_API_PORT:-8765}"
portal_port="${ISP_PORTAL_PORT:-8790}"
radius_auth="${ISP_RADIUS_AUTH_PORT:-1812}"
radius_acct="${ISP_RADIUS_ACCT_PORT:-1813}"
tunnel="${ISP_WG_IFACE:-isp-centric}"

# Running under sudo trips git's "dubious ownership" check otherwise.
if [ "$(id -u)" = "0" ]; then
    git config --global --add safe.directory "$PWD" 2>/dev/null || true
fi

echo "==> Fetching origin"
git fetch origin main

if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git status --porcelain | grep -v '^??')" ]; then
    echo "==> Local edits detected — stashing (recover with: git stash pop)"
    git stash push -m "update-vps $(date +%F-%T)"
fi

before=$(git rev-parse HEAD)
git pull --ff-only origin main
after=$(git rev-parse HEAD)

if [ "$before" = "$after" ]; then
    echo "==> Already at ${after:0:8} — restarting anyway"
else
    echo "==> Updated ${before:0:8} -> ${after:0:8}"
fi

echo "==> Python dependencies"
"$venv/bin/pip" install -q -r database/requirements.txt

frontend_changed=$(git diff --name-only "$before" "$after" -- frontend/ | grep -v '^frontend/dist' || true)
if [ -z "$frontend_changed" ] && [ -f frontend/dist/index.html ]; then
    echo "==> Frontend unchanged — skipping rebuild"
else
    node_major=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1 || echo 0)
    if [ "${node_major:-0}" -lt 20 ]; then
        if [ -f frontend/dist/index.html ]; then
            echo "!! Node ${node_major:-none} < 20 — keeping existing dist/, build it on a dev machine and scp it over"
        else
            echo "!! Node ${node_major:-none} < 20 and no dist/ — install Node 20+ or copy a built frontend/dist" >&2
            exit 1
        fi
    else
        echo "==> Building frontend"
        (cd frontend && npm ci --no-audit --no-fund && npm run build)
    fi
fi

echo "==> Restarting ${service}"

# A manual/orphaned `python api.py` outside systemd can hold any of our ports
# and make the restart start bind-failed — /api/health still answers 200, so
# RADIUS/portal would be silently dead. Kill strays on every port we own.
main_pid=$(systemctl show -p MainPID --value "$service" 2>/dev/null || echo 0)
for spec in "tlnp ${api_port}" "tlnp ${portal_port}" "ulnp ${radius_auth}" "ulnp ${radius_acct}"; do
    mode="${spec%% *}"
    port="${spec##* }"
    for pid in $(ss -${mode} 2>/dev/null | grep ":${port} " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
        if [ "$pid" != "$main_pid" ]; then
            echo "!! port ${port} held by stray pid ${pid} — killing it"
            kill "$pid" 2>/dev/null || true
            sleep 1
        fi
    done
done

systemctl restart "$service"

# RADIUS/portal traffic only arrives on the tunnel interface — keep ufw from
# dropping it (api.py also adds this rule once the tunnel is up).
if command -v ufw >/dev/null 2>&1; then
    ufw allow in on "$tunnel" >/dev/null 2>&1 || true
fi

# WireGuard bring-up + RADIUS/portal binds take a few seconds — give the API
# up to 30s to answer before declaring failure.
echo "==> Waiting for the API on 127.0.0.1:${api_port}"
healthy=""
for _ in $(seq 1 30); do
    if ! systemctl is-active --quiet "$service"; then
        break
    fi
    if curl -sf "http://127.0.0.1:${api_port}/api/health" 2>/dev/null | grep -qv 'bind-failed'; then
        healthy=1
        break
    fi
    sleep 1
done

if [ -z "$healthy" ]; then
    echo "!! service did not come up healthy — last 30 log lines:" >&2
    journalctl -u "$service" -n 30 --no-pager >&2
    exit 1
fi

echo "==> Health check"
curl -sf "http://127.0.0.1:${api_port}/api/health" && echo
if command -v wg >/dev/null 2>&1; then
    wg show "$tunnel" 2>/dev/null | grep -E 'peer:|latest handshake' || true
fi
echo "==> Done"
