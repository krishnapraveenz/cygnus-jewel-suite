-- 0022_invoice_tender.sql — split tender: how the net payable was settled across modes.
-- The tenders must sum to the invoice's net payable. 'credit' = unpaid balance (receivable).

CREATE TABLE invoice_tender (
    id         BIGSERIAL PRIMARY KEY,
    invoice_id BIGINT NOT NULL REFERENCES invoice(id),
    mode       TEXT NOT NULL
                 CHECK (mode IN ('cash', 'card', 'upi', 'bank_transfer', 'cheque', 'credit')),
    amount     NUMERIC(14,2) NOT NULL,
    reference  TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invoice_tender_inv ON invoice_tender (invoice_id);
