-- 0032_item_stone.sql — stone composition of a stock item (P3). The item already
-- carries its metal type/purity/weights; this records the stones set in it (captured
-- at smith-receive or purchase), so a tagged sale can carry the stones onto the bill.

CREATE TABLE item_stone (
    id               BIGSERIAL PRIMARY KEY,
    item_id          BIGINT NOT NULL REFERENCES item(id),
    stone_type_id    BIGINT REFERENCES stone_type(id),
    stone_quality_id BIGINT REFERENCES stone_quality(id),
    description      TEXT,
    carat            NUMERIC(10,3),
    pieces           INTEGER,
    rate             NUMERIC(14,2),
    value            NUMERIC(14,2) NOT NULL,
    certificate_no   TEXT,
    lab              TEXT
);
CREATE INDEX item_stone_item ON item_stone (item_id);
