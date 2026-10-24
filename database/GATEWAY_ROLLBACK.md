# Gateway schema — manual undo

There is no migration framework: `gateway_store.ensure_schema()` applies
idempotently at startup and `gateway_store.backfill_gateway_modes()` seeds
`isp_payout_settings`. To undo the whole gateway schema, run the statements
below against `ISP-DB` in order. They mirror `gateway_store.UNDO_STATEMENTS`;
`python database/test_gateway_db.py` exercises apply → undo → re-apply on a
scratch database.

> **Data loss:** this drops every gateway table — payments, ledger, batches,
> payouts, callbacks, audit rows, and payout settings are deleted permanently.

```sql
-- Append-only triggers first (they would block nothing, but drop them anyway)
DROP TRIGGER IF EXISTS gw_ledger_no_update;
DROP TRIGGER IF EXISTS gw_ledger_no_delete;

-- Dependents before parents
DROP TABLE IF EXISTS settlement_batch_entries;
DROP TABLE IF EXISTS gateway_ledger_entries;
DROP TABLE IF EXISTS gateway_payouts;
DROP TABLE IF EXISTS settlement_batches;
DROP TABLE IF EXISTS gateway_payments;
DROP TABLE IF EXISTS gateway_callback_events;
DROP TABLE IF EXISTS gateway_audit_log;
DROP TABLE IF EXISTS gateway_notifications;
DROP TABLE IF EXISTS gateway_fee_bands;

-- Columns added to isp_payout_settings after its creation (revert enum first —
-- rows may hold the new modes)
ALTER TABLE isp_payout_settings MODIFY COLUMN settlement_mode ENUM('immediate','delayed') NOT NULL DEFAULT 'immediate';
ALTER TABLE isp_payout_settings DROP COLUMN settle_every_n_tx;
ALTER TABLE isp_payout_settings DROP COLUMN settle_schedule;
ALTER TABLE isp_payout_settings DROP COLUMN last_settled_at;
DROP TABLE IF EXISTS isp_payout_settings;

-- Columns added to the existing company_daraja_settings table
ALTER TABLE company_daraja_settings DROP COLUMN callback_secret_enc;
ALTER TABLE company_daraja_settings DROP COLUMN initiator_name;
ALTER TABLE company_daraja_settings DROP COLUMN initiator_password_enc;
ALTER TABLE company_daraja_settings DROP COLUMN payout_shortcode;
ALTER TABLE company_daraja_settings DROP COLUMN status;
ALTER TABLE company_daraja_settings DROP COLUMN commission_percent;
ALTER TABLE company_daraja_settings DROP COLUMN commission_flat;
ALTER TABLE company_daraja_settings DROP COLUMN default_hold_hours;
ALTER TABLE company_daraja_settings DROP COLUMN min_payout;
ALTER TABLE company_daraja_settings DROP COLUMN max_payout_per_tx;
ALTER TABLE company_daraja_settings DROP COLUMN kill_switch;
ALTER TABLE company_daraja_settings DROP COLUMN last_verified_at;
ALTER TABLE company_daraja_settings DROP COLUMN payout_fee_estimate;
ALTER TABLE company_daraja_settings DROP COLUMN last_known_balance;
ALTER TABLE company_daraja_settings DROP COLUMN last_balance_at;
ALTER TABLE company_daraja_settings DROP COLUMN txn_fees_enabled;
ALTER TABLE company_daraja_settings DROP COLUMN public_base;
```

Re-apply by restarting `api.py` (or calling `gateway_store.ensure_schema`
followed by `gateway_store.backfill_gateway_modes`). Re-applying recreates
empty tables and re-runs the backfill — `gateway_mode` choices made by
owners are lost with the dropped table and revert to the backfill result.
