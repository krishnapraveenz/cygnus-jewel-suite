-- 0004_credit_notes.sql — returns / value reductions via GST credit notes (Sec. 34).
-- Original invoice stays immutable; the credit note is the offsetting document.

CREATE TABLE credit_note (
    id                  BIGSERIAL PRIMARY KEY,
    branch_id           BIGINT NOT NULL REFERENCES branch(id),
    original_invoice_id BIGINT NOT NULL REFERENCES invoice(id),
    customer_id         BIGINT REFERENCES customer(id),
    series_code         TEXT   NOT NULL,
    cn_no               BIGINT NOT NULL,
    document_no         TEXT   UNIQUE,
    fy                  TEXT   NOT NULL,
    reason              TEXT   NOT NULL DEFAULT 'return'
                          CHECK (reason IN ('return','rate_diff','cancellation','other')),
    subtotal            NUMERIC(14,2) NOT NULL,
    tax_total           NUMERIC(14,2) NOT NULL,
    total               NUMERIC(14,2) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (series_code, fy, cn_no)
);

CREATE TABLE credit_note_line (
    id             BIGSERIAL PRIMARY KEY,
    credit_note_id BIGINT NOT NULL REFERENCES credit_note(id),
    item_id        BIGINT REFERENCES item(id),
    description    TEXT,
    taxable_value  NUMERIC(14,2) NOT NULL,
    line_total     NUMERIC(14,2) NOT NULL
);
