-- 0047_purchase_return.sql — vendor returns (debit note, DBN-…). Returns selected lines of a
-- purchase bill to the supplier: items leave stock, payable to the supplier is reduced.

CREATE TABLE purchase_return (
    id               BIGSERIAL PRIMARY KEY,
    branch_id        BIGINT NOT NULL REFERENCES branch(id),
    purchase_bill_id BIGINT NOT NULL REFERENCES purchase_bill(id),
    party_id         BIGINT REFERENCES party(id),
    series_code      TEXT   NOT NULL,
    return_no        BIGINT NOT NULL,
    document_no      TEXT   UNIQUE,
    fy               TEXT   NOT NULL,
    subtotal         NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_total        NUMERIC(14,2) NOT NULL DEFAULT 0,
    total            NUMERIC(14,2) NOT NULL DEFAULT 0,
    refund_mode      TEXT,                       -- 'payable_adjust' | 'cash' | 'bank' | ...
    note             TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (series_code, fy, return_no)
);

CREATE TABLE purchase_return_line (
    id                    BIGSERIAL PRIMARY KEY,
    purchase_return_id    BIGINT NOT NULL REFERENCES purchase_return(id),
    purchase_bill_line_id BIGINT REFERENCES purchase_bill_line(id),
    item_id               BIGINT REFERENCES item(id),
    description           TEXT,
    taxable_value         NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_amount            NUMERIC(14,2) NOT NULL DEFAULT 0,
    line_total            NUMERIC(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX purchase_return_bill ON purchase_return (purchase_bill_id);

-- Mark which purchase-bill lines have been returned so they can't be returned twice.
ALTER TABLE purchase_bill_line ADD COLUMN IF NOT EXISTS returned BOOLEAN NOT NULL DEFAULT false;
