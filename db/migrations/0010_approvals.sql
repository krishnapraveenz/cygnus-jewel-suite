-- 0010_approvals.sql — On-Approval (take-home trial, B2C). NOT a sale: no invoice, no GST.
-- The item leaves stock as 'on_approval_out' but ownership stays with the shop.

CREATE TABLE approval_out (
    id          BIGSERIAL PRIMARY KEY,
    branch_id   BIGINT NOT NULL REFERENCES branch(id),
    item_id     BIGINT NOT NULL REFERENCES item(id),
    customer_id BIGINT REFERENCES customer(id),
    slip_no     TEXT,                              -- e.g. APP-2627-0001 (tracking, not a tax doc)
    out_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    due_back_at DATE,
    status      TEXT NOT NULL DEFAULT 'out'
                  CHECK (status IN ('out', 'returned', 'converted')),
    created_by  BIGINT
);

CREATE INDEX approval_out_open ON approval_out (status) WHERE status = 'out';
