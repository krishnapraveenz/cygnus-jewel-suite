-- 0017_sales_return.sql — return-window setting, per-line returned flag, and
-- richer credit notes (refund mode + deduction) for partial/multi-line sales returns.

CREATE TABLE IF NOT EXISTS app_setting (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Default policy: 7-day return window (manually overridable per return).
INSERT INTO app_setting (key, value) VALUES ('return_window_days', '7')
    ON CONFLICT (key) DO NOTHING;

-- Track which invoice lines have already been returned (enables partial returns).
ALTER TABLE invoice_line ADD COLUMN IF NOT EXISTS returned BOOLEAN NOT NULL DEFAULT false;

-- Credit note: how the refund was settled, any deduction, and the net refund.
ALTER TABLE credit_note ADD COLUMN IF NOT EXISTS refund_mode TEXT;
ALTER TABLE credit_note ADD COLUMN IF NOT EXISTS deduction   NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE credit_note ADD COLUMN IF NOT EXISTS net_refund  NUMERIC(14,2);
