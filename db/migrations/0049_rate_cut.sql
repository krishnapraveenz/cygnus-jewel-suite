-- 0049_rate_cut.sql — rate cutting: fix an unfixed metal (fine-gram) position on a party's
-- account into money at a chosen bullion rate. Works both ways:
--   they_owe (B2B customer owes us grams)  → grams −, money + on their account
--   we_owe   (we owe a supplier grams)     → grams +, money − on their account
-- Supports partial cuts. Party balances live in the ledger (subject_type='party').

CREATE TABLE rate_cut (
    id          BIGSERIAL PRIMARY KEY,
    branch_id   BIGINT NOT NULL REFERENCES branch(id),
    party_id    BIGINT NOT NULL REFERENCES party(id),
    series_code TEXT   NOT NULL,
    cut_no      BIGINT NOT NULL,
    document_no TEXT   UNIQUE,
    fy          TEXT   NOT NULL,
    grams       NUMERIC(12,3) NOT NULL CHECK (grams > 0),
    rate        NUMERIC(14,2) NOT NULL CHECK (rate > 0),
    amount      NUMERIC(14,2) NOT NULL,
    direction   TEXT   NOT NULL CHECK (direction IN ('we_owe','they_owe')),
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (series_code, fy, cut_no)
);
CREATE INDEX rate_cut_party ON rate_cut (party_id);
