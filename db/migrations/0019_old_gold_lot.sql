-- 0019_old_gold_lot.sql — register old gold taken in exchange as a scrap-stock lot.
-- Old gold is valued at the day's BUY rate for its purity, less an optional deduction
-- (melting/refining loss). It carries NO GST. Each lot is tracked in stock until refined.

CREATE TABLE old_gold_lot (
    id                BIGSERIAL PRIMARY KEY,
    branch_id         BIGINT NOT NULL REFERENCES branch(id),
    invoice_id        BIGINT REFERENCES invoice(id),
    customer_id       BIGINT REFERENCES customer(id),
    metal_type_id     BIGINT NOT NULL REFERENCES metal_type(id),
    purity_id         BIGINT REFERENCES purity(id),
    gross_weight      NUMERIC(12,3) NOT NULL,
    deduction_percent NUMERIC(5,2)  NOT NULL DEFAULT 0,
    net_weight        NUMERIC(12,3) NOT NULL,
    rate              NUMERIC(14,2) NOT NULL,
    value             NUMERIC(14,2) NOT NULL,
    status            TEXT NOT NULL DEFAULT 'in_scrap'
                        CHECK (status IN ('in_scrap','refined','sold')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX old_gold_lot_invoice ON old_gold_lot (invoice_id);
