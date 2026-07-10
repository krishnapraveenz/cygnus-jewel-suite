-- 0011_sale_or_return.sql — Sale or Return (B2B). Goods sent to a retailer to sell.
-- Title stays with us until invoiced; NOT a sale until then. Item state: sale_or_return_out.

CREATE TABLE sale_or_return_out (
    id          BIGSERIAL PRIMARY KEY,
    branch_id   BIGINT NOT NULL REFERENCES branch(id),
    item_id     BIGINT NOT NULL REFERENCES item(id),
    customer_id BIGINT REFERENCES customer(id),   -- the retailer receiving the goods
    doc_no      TEXT,                              -- delivery-note number (SOR-...)
    out_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    due_back_at DATE,
    status      TEXT NOT NULL DEFAULT 'out'
                  CHECK (status IN ('out', 'returned', 'invoiced')),
    created_by  BIGINT
);

CREATE INDEX sor_out_open ON sale_or_return_out (status) WHERE status = 'out';
