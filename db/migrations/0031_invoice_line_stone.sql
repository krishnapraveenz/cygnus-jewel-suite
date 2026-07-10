-- 0031_invoice_line_stone.sql — per-line stone breakdown captured at billing from the
-- Materials catalogue (P3). The line's flat stone_value still drives the engine; this
-- table records WHICH stones make up that value, for the printed invoice & certificates.

CREATE TABLE invoice_line_stone (
    id               BIGSERIAL PRIMARY KEY,
    invoice_line_id  BIGINT NOT NULL REFERENCES invoice_line(id),
    stone_type_id    BIGINT REFERENCES stone_type(id),
    stone_quality_id BIGINT REFERENCES stone_quality(id),
    description      TEXT,                 -- denormalised name/grade for printing
    carat            NUMERIC(10,3),
    pieces           INTEGER,
    rate             NUMERIC(14,2),        -- per carat or per piece
    value            NUMERIC(14,2) NOT NULL,
    certificate_no   TEXT,
    lab              TEXT
);
CREATE INDEX invoice_line_stone_line ON invoice_line_stone (invoice_line_id);
