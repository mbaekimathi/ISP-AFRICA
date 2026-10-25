# Gateway testing

## Test layers

| Layer | Command | Needs |
|---|---|---|
| Crypto + mode/guards | `python database/test_gateway_crypto.py` `python database/test_gateway_mode.py` | nothing — offline |
| Live schema + locks | `python database/test_gateway_db.py` | reachable MySQL (ISP_DB_* env) |
| Daraja client unit tests | `python database/test_daraja_client.py` | nothing — mocked transport |
| Daraja end-to-end | Phase 3+ | sandbox creds + public callback URL + cert |

Payout-side calls (B2C, B2B, Transaction Status, Account Balance, Reversal)
need the initiator password encrypted with Safaricom's public certificate —
the published certs ship in `database/certs/`, so this works with no setup;
`ISP_DARAJA_CERT_SANDBOX` / `ISP_DARAJA_CERT_LIVE` (a PEM path or inline PEM)
override only when Safaricom rotates a cert.

`test_gateway_db.py` creates a scratch database (`ISP-DB-GWTEST`, override
with `ISP_GATEWAY_TEST_DB`), exercises apply/undo/re-apply, ledger triggers,
unique constraints, `SELECT ... FOR UPDATE`, and `GET_LOCK`, then drops the
database. It skips automatically when MySQL is unreachable.

## Public HTTPS for Daraja callbacks (development)

The callback base is learned automatically: when a director opens the
company payments page through the server's public https domain (behind the
nginx proxy — never a direct or plain-http connection), `api.py` remembers
`https://<host>` in `company_daraja_settings.public_base` and every
callback URL builds from it. `ISP_GATEWAY_PUBLIC_URL` still overrides the
learned value when set — use it for tunnels whose URL the dashboard isn't
reached through.

B2C, B2B, Transaction Status, and Account Balance all deliver results only
to public `ResultURL`/`QueueTimeOutURL` endpoints — polling is **not** a full
fallback for payouts, so sandbox end-to-end needs a public URL that reaches
`api.py` (default port 8765).

**Cloudflare Tunnel (free, no account needed for a quick tunnel):**

```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://127.0.0.1:8765
```

It prints a `https://<random>.trycloudflare.com` URL. Set it as
`ISP_GATEWAY_PUBLIC_URL` — pooled STK pushes then carry
`<base>/api/daraja/<callback_secret>/stk` as their CallBackURL. The secret is
generated on first read of the director payments page and shown only there.
Live endpoints: `stk`, `c2b/validation`, `c2b/confirmation`, `b2c/result`,
`b2c/timeout`, `b2b/result`, `b2b/timeout`, `account-balance` — all under
`/api/daraja/<callback_secret>/`; an unknown secret gets a plain 404.

Director ops routes under `/api/employee/company/gateway/`:
GET `overview`, `clients` (custody + assign directory), `payments`, `payouts`,
`batches`, `ledger`, `audit`, `notifications`, `suspense`, `pending-changes`,
`settings`, `export?kind=payments|payouts|batches|ledger`; POST
`suspense/assign`, `settings` (kill switch, status, initiator, commission,
limits), `payouts/check` (Transaction Status probe — answer arrives on the
result callback), `payouts/mark-failed` (only payouts that never reached
Daraja). ISP routes under `/api/gateway/`: GET `summary`, `settings`
(`readOnly` for staff sessions), `payments`, `payouts`, `ledger`,
`notifications`; POST `settings` (owner + password re-entry).

**ngrok (alternative):**

```powershell
ngrok http 8765
# -> https://<id>.ngrok-free.app forwarding to 127.0.0.1:8765
```

**VPS / production:** `deploy/nginx-site.conf` already fronts the API with
certbot-managed HTTPS (see DEPLOYMENT.md "Deploying to an Ubuntu VPS") — the
same site serves the callback paths, no extra config needed.

Notes:

- The legacy `ISP_DARAJA_CALLBACK` + `ISP_DARAJA_CALLBACK_TOKEN` variables
  remain for the existing STK annotation callback; the gateway callbacks
  carry the company `callback_secret` in the path instead.
- STK confirmation never depends on callbacks: stkpushquery stays the source
  of truth, so collections work on a laptop with no tunnel. Payout
  confirmation uses the result callback plus Transaction Status verification.
