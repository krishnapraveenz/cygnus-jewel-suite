-- Bank account management + account-wise reconciliation.
CREATE TABLE IF NOT EXISTS bank_account (
    id              BIGSERIAL PRIMARY KEY,
    branch_id       BIGINT,
    name            TEXT NOT NULL,
    bank_name       TEXT,
    account_no      TEXT,
    ifsc            TEXT,
    opening_balance NUMERIC NOT NULL DEFAULT 0,
    is_primary      BOOLEAN NOT NULL DEFAULT false,
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reconciliation state per bank money-movement (keyed by its source document line).
-- Non-invasive: the movement itself lives in invoice_tender / purchase_payment / expense /
-- customer_receipt / payslip / staff_advance; this table only assigns it to an account and
-- tracks clearance.
CREATE TABLE IF NOT EXISTS bank_recon (
    id              BIGSERIAL PRIMARY KEY,
    branch_id       BIGINT,
    source_type     TEXT NOT NULL,
    source_id       BIGINT NOT NULL,
    bank_account_id BIGINT REFERENCES bank_account(id),
    cleared         BOOLEAN NOT NULL DEFAULT false,
    cleared_on      DATE,
    note            TEXT,
    UNIQUE (source_type, source_id)
);
CREATE INDEX IF NOT EXISTS bank_recon_acct_idx ON bank_recon(bank_account_id);

INSERT INTO bank_account (name, bank_name, is_primary, opening_balance)
SELECT 'Main Bank', 'Bank', true, 0
WHERE NOT EXISTS (SELECT 1 FROM bank_account);
