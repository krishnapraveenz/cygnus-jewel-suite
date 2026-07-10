-- 0002_invoices.sql — sales: customers, invoices, lines, and per-series numbering.
-- Invoice numbering (Rule 46): consecutive & unique within FY per series (decision D9).

CREATE TABLE customer (
    id          BIGSERIAL PRIMARY KEY,
    branch_id   BIGINT REFERENCES branch(id),
    name        TEXT NOT NULL,
    phone       TEXT,
    pan         TEXT,                 -- required by app rule when bill crosses threshold
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Gapless per-(series, FY) counter; incremented under a row lock at sale time.
CREATE TABLE invoice_counter (
    series_code TEXT   NOT NULL,
    fy          TEXT   NOT NULL,
    last_no     BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (series_code, fy)
);

CREATE TABLE invoice (
    id             BIGSERIAL PRIMARY KEY,
    branch_id      BIGINT NOT NULL REFERENCES branch(id),
    customer_id    BIGINT REFERENCES customer(id),
    series_code    TEXT   NOT NULL,
    invoice_no     BIGINT NOT NULL,
    fy             TEXT   NOT NULL,
    type           TEXT   NOT NULL DEFAULT 'retail' CHECK (type IN ('retail','b2b')),
    subtotal       NUMERIC(14,2) NOT NULL,
    discount_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_total      NUMERIC(14,2) NOT NULL,
    grand_total    NUMERIC(14,2) NOT NULL,
    status         TEXT NOT NULL DEFAULT 'final',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (series_code, fy, invoice_no)
);

CREATE TABLE invoice_line (
    id             BIGSERIAL PRIMARY KEY,
    invoice_id     BIGINT NOT NULL REFERENCES invoice(id),
    item_id        BIGINT REFERENCES item(id),
    description    TEXT,
    rate_used      NUMERIC(14,2) NOT NULL,
    was_override   BOOLEAN NOT NULL DEFAULT false,
    breakdown_json JSONB NOT NULL,          -- frozen PriceBreakdown snapshot
    taxable_value  NUMERIC(14,2) NOT NULL,
    line_total     NUMERIC(14,2) NOT NULL
);
