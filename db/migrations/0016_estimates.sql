-- 0016_estimates.sql — Estimates (quotations). Same-day validity: an estimate is valid
-- only on the date it was created; after that it is expired and cannot be converted.
-- NOT a tax document: never posts to the ledger or stock, carries no GST liability
-- (tax shown is indicative only). On conversion it builds a real invoice.

CREATE TABLE estimate (
    id                   BIGSERIAL PRIMARY KEY,
    branch_id            BIGINT NOT NULL REFERENCES branch(id),
    customer_id          BIGINT REFERENCES customer(id),
    series_code          TEXT   NOT NULL,
    est_no               BIGINT NOT NULL,
    document_no          TEXT   NOT NULL,
    fy                   TEXT   NOT NULL,
    type                 TEXT   NOT NULL DEFAULT 'retail' CHECK (type IN ('retail','b2b')),
    inter_state          BOOLEAN NOT NULL DEFAULT false,
    subtotal             NUMERIC(14,2) NOT NULL,
    discount_total       NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_total            NUMERIC(14,2) NOT NULL,
    grand_total          NUMERIC(14,2) NOT NULL,
    old_gold_value       NUMERIC(14,2) NOT NULL DEFAULT 0,
    status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','converted','expired')),
    converted_invoice_id BIGINT REFERENCES invoice(id),
    valid_on             DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (series_code, fy, est_no)
);

CREATE TABLE estimate_line (
    id             BIGSERIAL PRIMARY KEY,
    estimate_id    BIGINT NOT NULL REFERENCES estimate(id),
    line_input     JSONB  NOT NULL,          -- raw InvoiceLineReq, replayed on conversion
    description    TEXT,
    hsn            TEXT,
    purity_label   TEXT,
    gross_weight   NUMERIC(12,3),
    net_weight     NUMERIC(12,3),
    huid           TEXT,
    making_label   TEXT,
    rate_used      NUMERIC(14,2) NOT NULL,
    breakdown_json JSONB NOT NULL,
    taxable_value  NUMERIC(14,2) NOT NULL,
    line_total     NUMERIC(14,2) NOT NULL
);
CREATE INDEX estimate_line_estimate ON estimate_line (estimate_id);
