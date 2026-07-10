-- 0023_cheque.sql — cheque register. Cheque tenders on invoices are tracked here through
-- their lifecycle: received → deposited → cleared / bounced. A bounce reverses the payment.

CREATE TABLE cheque (
    id           BIGSERIAL PRIMARY KEY,
    branch_id    BIGINT NOT NULL REFERENCES branch(id),
    invoice_id   BIGINT REFERENCES invoice(id),
    customer_id  BIGINT REFERENCES customer(id),
    cheque_no    TEXT,
    bank         TEXT,
    amount       NUMERIC(14,2) NOT NULL,
    status       TEXT NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received', 'deposited', 'cleared', 'bounced')),
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deposited_at TIMESTAMPTZ,
    cleared_at   TIMESTAMPTZ,
    bounced_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cheque_status ON cheque (status, id DESC);
