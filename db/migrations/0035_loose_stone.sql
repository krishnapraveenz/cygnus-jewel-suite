-- 0035_loose_stone.sql — loose-stone inventory. Stones bought back from old jewellery
-- (or entered manually / from a purchase) become reusable stock that can be set into new
-- ornaments or sold. Tracked by type/quality/carat/pieces with certificate + provenance.

CREATE TABLE loose_stone (
    id                BIGSERIAL PRIMARY KEY,
    branch_id         BIGINT REFERENCES branch(id),
    stone_type_id     BIGINT REFERENCES stone_type(id),
    stone_quality_id  BIGINT REFERENCES stone_quality(id),
    description       TEXT,
    carat             NUMERIC(10,3),
    pieces            INTEGER,
    cost_value        NUMERIC(14,2) NOT NULL DEFAULT 0,
    certificate_no    TEXT,
    lab               TEXT,
    source            TEXT NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('manual', 'old_gold', 'purchase')),
    old_gold_stone_id BIGINT REFERENCES old_gold_stone(id),
    status            TEXT NOT NULL DEFAULT 'in_stock'
                        CHECK (status IN ('in_stock', 'used', 'sold')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX loose_stone_status ON loose_stone (status);
