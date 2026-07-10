-- Customer receipts: money received against a party's outstanding (credit-sale debtors).
CREATE TABLE IF NOT EXISTS customer_receipt (
    id           BIGSERIAL PRIMARY KEY,
    branch_id    BIGINT,
    party_id     BIGINT NOT NULL REFERENCES party(id),
    receipt_date DATE NOT NULL,
    amount       NUMERIC NOT NULL,
    mode         TEXT NOT NULL DEFAULT 'cash',   -- cash | upi | card | bank_transfer | cheque
    reference    TEXT,
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_receipt_party_idx ON customer_receipt(party_id);
CREATE INDEX IF NOT EXISTS customer_receipt_date_idx ON customer_receipt(receipt_date);
