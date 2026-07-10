-- 0001_init.sql — Cygnus Jewel Suite, Phase 1 core schema (initial slice).
-- Decimal/NUMERIC for all weight & money; append-only event ledger is the source of truth.
-- This is a starting slice (Foundation + Stock + Rates); expand per data-model-erd.md.

CREATE TABLE branch (
    id           BIGSERIAL PRIMARY KEY,
    company_id   BIGINT        NOT NULL,
    name         TEXT          NOT NULL,
    type         TEXT          NOT NULL CHECK (type IN ('showroom','warehouse')),
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE metal_type (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL CHECK (name IN ('gold','silver','platinum')),
    base_unit    TEXT NOT NULL DEFAULT 'gram'
);

CREATE TABLE purity (
    id             BIGSERIAL PRIMARY KEY,
    metal_type_id  BIGINT NOT NULL REFERENCES metal_type(id),
    label          TEXT   NOT NULL,            -- '22K', '18K', '999.9', '925'
    karat          NUMERIC(5,2),               -- nullable for pure-fineness grades
    fineness       INTEGER NOT NULL,           -- parts per 1000 (916, 750, 999)
    UNIQUE (metal_type_id, label)
);

-- One row per (metal, purity); rates entered INDEPENDENTLY per purity (decision D2).
CREATE TABLE metal_rate (
    id             BIGSERIAL PRIMARY KEY,
    branch_id      BIGINT REFERENCES branch(id),       -- NULL = global default
    metal_type_id  BIGINT NOT NULL REFERENCES metal_type(id),
    purity_id      BIGINT NOT NULL REFERENCES purity(id),
    basis          TEXT NOT NULL DEFAULT 'per_gram_karat'
                     CHECK (basis IN ('per_gram_karat','per_gram_pure')),
    buy_rate       NUMERIC(14,2) NOT NULL,
    sell_rate      NUMERIC(14,2) NOT NULL,
    effective_from TIMESTAMPTZ   NOT NULL DEFAULT now(),
    created_by     BIGINT
);
CREATE INDEX metal_rate_lookup
    ON metal_rate (metal_type_id, purity_id, effective_from DESC);

CREATE TABLE item (
    id              BIGSERIAL PRIMARY KEY,
    branch_id       BIGINT NOT NULL REFERENCES branch(id),
    sku             TEXT   NOT NULL,
    metal_type_id   BIGINT NOT NULL REFERENCES metal_type(id),
    purity_id       BIGINT NOT NULL REFERENCES purity(id),
    gross_weight    NUMERIC(12,3) NOT NULL,
    net_weight      NUMERIC(12,3) NOT NULL,
    stone_weight    NUMERIC(12,3) NOT NULL DEFAULT 0,
    huid            TEXT,
    certificate_no  TEXT,
    cost_value      NUMERIC(14,2),
    ownership_state TEXT NOT NULL DEFAULT 'in_stock'
        CHECK (ownership_state IN
            ('in_stock','on_approval_out','sale_or_return_out','received_in','sold','written_off')),
    location        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (branch_id, sku)
);

-- Append-only event ledger (decision: backbone of stability/audit).
CREATE TABLE ledger_event (
    id            BIGSERIAL PRIMARY KEY,
    branch_id     BIGINT NOT NULL REFERENCES branch(id),
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id       BIGINT,
    subject_type  TEXT NOT NULL,    -- 'item' | 'lot' | 'cash' | 'metal' | 'stone'
    subject_id    BIGINT NOT NULL,
    event_type    TEXT NOT NULL,
    before_json   JSONB,
    after_json    JSONB,
    weight_delta  NUMERIC(12,3),
    amount_delta  NUMERIC(14,2),
    ref_doc_type  TEXT,
    ref_doc_id    BIGINT
);
CREATE INDEX ledger_event_subject
    ON ledger_event (subject_type, subject_id, occurred_at);

-- ledger_event is INSERT-only: no UPDATE/DELETE (enforced in app + DB role grants).
