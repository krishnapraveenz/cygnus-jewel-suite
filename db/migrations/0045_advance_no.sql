-- 0045_advance_no.sql — continuous document number per advance (ADV-…), via document_series.

ALTER TABLE customer_advance ADD COLUMN IF NOT EXISTS advance_no TEXT;
