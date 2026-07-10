-- 0033_old_gold_stone.sql — stones recovered from old jewellery taken in exchange.
-- action: 'returned' (handed back to the customer, no value) or 'bought' (we buy the
-- stone too; its value is added to what we credit the customer).

CREATE TABLE old_gold_stone (
    id               BIGSERIAL PRIMARY KEY,
    old_gold_lot_id  BIGINT NOT NULL REFERENCES old_gold_lot(id),
    stone_type_id    BIGINT REFERENCES stone_type(id),
    stone_quality_id BIGINT REFERENCES stone_quality(id),
    description      TEXT,
    carat            NUMERIC(10,3),
    pieces           INTEGER,
    value            NUMERIC(14,2) NOT NULL DEFAULT 0,
    action           TEXT NOT NULL DEFAULT 'returned' CHECK (action IN ('returned', 'bought'))
);
CREATE INDEX old_gold_stone_lot ON old_gold_stone (old_gold_lot_id);
