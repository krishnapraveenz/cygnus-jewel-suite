-- Bank statement import + reconciliation matching (CSV/Excel).
CREATE TABLE IF NOT EXISTS stmt_import (
    id              BIGSERIAL PRIMARY KEY,
    branch_id       BIGINT,
    bank_account_id BIGINT NOT NULL REFERENCES bank_account(id) ON DELETE CASCADE,
    filename        TEXT,
    format          TEXT,
    line_count      INT NOT NULL DEFAULT 0,
    imported_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stmt_line (
    id              BIGSERIAL PRIMARY KEY,
    import_id       BIGINT NOT NULL REFERENCES stmt_import(id) ON DELETE CASCADE,
    bank_account_id BIGINT NOT NULL,
    txn_date        DATE,
    description     TEXT,
    ref_no          TEXT,
    debit           NUMERIC NOT NULL DEFAULT 0,
    credit          NUMERIC NOT NULL DEFAULT 0,
    amount          NUMERIC NOT NULL DEFAULT 0,     -- signed: credit − debit (money into bank +)
    balance         NUMERIC,
    match_status    TEXT NOT NULL DEFAULT 'unmatched',  -- unmatched | matched | ignored
    matched_source_type TEXT,
    matched_source_id   BIGINT
);
CREATE INDEX IF NOT EXISTS stmt_line_import_idx ON stmt_line(import_id);
CREATE INDEX IF NOT EXISTS stmt_line_acct_idx ON stmt_line(bank_account_id);
