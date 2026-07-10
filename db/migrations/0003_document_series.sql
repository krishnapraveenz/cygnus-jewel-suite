-- 0003_document_series.sql — configurable, prefix/suffix + zero-padded sequential
-- document numbers (decision D9). Set per (doc_type, FY, series) at FY start.
-- GST Rule 46: final number must be <= 16 chars, unique & consecutive within the FY.

DROP TABLE IF EXISTS invoice_counter;

CREATE TABLE document_series (
    doc_type    TEXT    NOT NULL,                 -- 'invoice' | 'credit_note' | 'approval_slip' | ...
    fy          TEXT    NOT NULL,                 -- '2026-27'
    series_code TEXT    NOT NULL DEFAULT 'MAIN',  -- per-terminal/branch series (offline-safe)
    prefix      TEXT    NOT NULL DEFAULT '',      -- e.g. 'INV-2627-'
    suffix      TEXT    NOT NULL DEFAULT '',      -- e.g. '' or '/A'
    pad_width   INT     NOT NULL DEFAULT 4 CHECK (pad_width BETWEEN 1 AND 12),
    next_no     BIGINT  NOT NULL DEFAULT 1 CHECK (next_no >= 1),  -- next sequence to assign
    active      BOOLEAN NOT NULL DEFAULT true,
    PRIMARY KEY (doc_type, fy, series_code)
);

-- Store the full formatted number on the invoice (e.g. 'INV-2627-0001').
ALTER TABLE invoice ADD COLUMN document_no TEXT;
UPDATE invoice
   SET document_no = 'INV-2627-' || lpad(invoice_no::text, 4, '0')
 WHERE document_no IS NULL;
ALTER TABLE invoice ADD CONSTRAINT invoice_document_no_uniq UNIQUE (document_no);

-- Seed the invoice series for the current FY, continuing after any existing numbers.
INSERT INTO document_series (doc_type, fy, series_code, prefix, suffix, pad_width, next_no)
VALUES ('invoice', '2026-27', 'T1', 'INV-2627-', '', 4,
        COALESCE((SELECT max(invoice_no) + 1 FROM invoice WHERE series_code = 'T1' AND fy = '2026-27'), 1));
