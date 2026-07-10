-- 0050_stock_lot.sql — bulk purchase lots (Scenario B). A lot is bulk metal bought as a
-- single entry (e.g. 1024 g of 22K, N pieces) that is later "tagged" — each piece weighed
-- and carved out as a barcoded item, decrementing the lot's remaining balance.

CREATE TABLE stock_lot (
    id               BIGSERIAL PRIMARY KEY,
    branch_id        BIGINT NOT NULL REFERENCES branch(id),
    purchase_bill_id BIGINT REFERENCES purchase_bill(id),
    lot_no           TEXT,
    metal_type_id    BIGINT NOT NULL REFERENCES metal_type(id),
    purity_id        BIGINT NOT NULL REFERENCES purity(id),
    gross_weight     NUMERIC(12,3) NOT NULL,
    net_weight       NUMERIC(12,3) NOT NULL,
    stone_weight     NUMERIC(12,3) NOT NULL DEFAULT 0,
    pieces           INT NOT NULL DEFAULT 0,
    remaining_gross  NUMERIC(12,3) NOT NULL,
    remaining_pieces INT NOT NULL DEFAULT 0,
    cost_value       NUMERIC(14,2) NOT NULL DEFAULT 0,
    fine_weight      NUMERIC(12,3) NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_lot_status ON stock_lot (status);

-- Which lot a tagged piece was carved from (null for directly-tagged / itemised pieces).
ALTER TABLE item ADD COLUMN IF NOT EXISTS lot_id BIGINT REFERENCES stock_lot(id);

-- Allow purchase-bill lines to reference a lot (item_id already nullable).
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS stock_lot_id BIGINT REFERENCES stock_lot(id);

ALTER TABLE purchase_bill_line DROP CONSTRAINT IF EXISTS purchase_bill_line_pricing_mode_check;
ALTER TABLE purchase_bill_line ADD CONSTRAINT purchase_bill_line_pricing_mode_check
    CHECK (pricing_mode IN ('fixed_cost','weight_rate','touch','stone','lot'));
