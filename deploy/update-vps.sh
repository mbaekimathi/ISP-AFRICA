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
venv/bin/pip install -q -r database/requirements.txt

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

echo "==> Restarting isp-centric"
systemctl restart isp-centric
sleep 3

# RADIUS/portal traffic only arrives on the tunnel interface — keep ufw from
# dropping it (api.py also adds this rule once the tunnel is up).
if command -v ufw >/dev/null 2>&1; then
    ufw allow in on isp-centric >/dev/null 2>&1 || true
fi

if ! systemctl is-active --quiet isp-centric; then
    echo "!! service failed to start — last 30 log lines:" >&2
    journalctl -u isp-centric -n 30 --no-pager >&2
    exit 1
fi

echo "==> Health check"
curl -sf http://127.0.0.1:8765/api/health && echo
echo "==> Done"
