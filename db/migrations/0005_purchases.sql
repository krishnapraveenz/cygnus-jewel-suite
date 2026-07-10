-- 0005_purchases.sql — suppliers + purchase bills (inbound stock).
-- A purchase RECEIVES stock: each line creates an item (ownership 'in_stock').

CREATE TABLE supplier (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    gstin       TEXT,
    balance     NUMERIC(14,2) NOT NULL DEFAULT 0,   -- amount we owe the supplier
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_bill (
    id                  BIGSERIAL PRIMARY KEY,
    branch_id           BIGINT NOT NULL REFERENCES branch(id),
    supplier_id         BIGINT NOT NULL REFERENCES supplier(id),
    series_code         TEXT   NOT NULL,
    bill_no             BIGINT NOT NULL,
    document_no         TEXT   UNIQUE,
    fy                  TEXT   NOT NULL,
    supplier_invoice_no TEXT,                        -- the supplier's own bill number
    total               NUMERIC(14,2) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (series_code, fy, bill_no)
);

CREATE TABLE purchase_bill_line (
    id               BIGSERIAL PRIMARY KEY,
    purchase_bill_id BIGINT NOT NULL REFERENCES purchase_bill(id),
    item_id          BIGINT REFERENCES item(id),
    description      TEXT,
    cost_value       NUMERIC(14,2) NOT NULL
);
