-- Fund transfers between own bank accounts (contra — nets to zero in the Bank control).
CREATE TABLE IF NOT EXISTS bank_transfer (
    id              BIGSERIAL PRIMARY KEY,
    branch_id       BIGINT,
    from_account_id BIGINT NOT NULL REFERENCES bank_account(id),
    to_account_id   BIGINT NOT NULL REFERENCES bank_account(id),
    amount          NUMERIC NOT NULL,
    transfer_date   DATE NOT NULL,
    reference       TEXT,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bank_transfer_from_idx ON bank_transfer(from_account_id);
CREATE INDEX IF NOT EXISTS bank_transfer_to_idx ON bank_transfer(to_account_id);
