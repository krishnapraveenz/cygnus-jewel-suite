-- 0021_customer_advance.sql — customer advances (booking money / part payment held as a
-- credit) and their application against invoices. Lifecycle: active → consumed (balance 0)
-- → (refunded). Applied amounts reduce an invoice's net payable, after old gold & scheme.

CREATE TABLE customer_advance (
    id           BIGSERIAL PRIMARY KEY,
    branch_id    BIGINT NOT NULL REFERENCES branch(id),
    customer_id  BIGINT NOT NULL REFERENCES customer(id),
    amount       NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    balance      NUMERIC(14,2) NOT NULL,
    note         TEXT,
    payment_mode TEXT,
    status       TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'consumed', 'refunded')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customer_advance_cust ON customer_advance (customer_id, status);

-- How much advance was applied to a given invoice (part of the payable waterfall).
ALTER TABLE invoice ADD COLUMN advance_applied NUMERIC(14,2) NOT NULL DEFAULT 0;
