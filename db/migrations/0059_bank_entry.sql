-- Bank account type + manual bank entries (deposits, withdrawals, interest, charges).
ALTER TABLE bank_account ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'current';
-- savings | current | od | cc

CREATE TABLE IF NOT EXISTS bank_entry (
    id              BIGSERIAL PRIMARY KEY,
    branch_id       BIGINT,
    bank_account_id BIGINT NOT NULL REFERENCES bank_account(id),
    entry_date      DATE NOT NULL,
    kind            TEXT NOT NULL,   -- deposit | withdrawal | interest | charges | other_credit | other_debit
    amount          NUMERIC NOT NULL,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bank_entry_acct_idx ON bank_entry(bank_account_id);
CREATE INDEX IF NOT EXISTS bank_entry_date_idx ON bank_entry(entry_date);
