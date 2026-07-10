-- 0037_resale_item.sql — second-hand pieces resold AS-IS (not melted/remade). Under the
-- GST margin scheme, tax applies only to the margin (sale − purchase cost), not full value.

CREATE TABLE resale_item (
    id              BIGSERIAL PRIMARY KEY,
    branch_id       BIGINT REFERENCES branch(id),
    description     TEXT NOT NULL,
    metal_type_id   BIGINT REFERENCES metal_type(id),
    purity_id       BIGINT REFERENCES purity(id),
    gross_weight    NUMERIC(12,3),
    net_weight      NUMERIC(12,3),
    purchase_cost   NUMERIC(14,2) NOT NULL,
    source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'old_gold')),
    old_gold_lot_id BIGINT REFERENCES old_gold_lot(id),
    status          TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'sold')),
    sale_price      NUMERIC(14,2),
    margin          NUMERIC(14,2),
    gst             NUMERIC(14,2),
    sold_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX resale_item_status ON resale_item (status);
