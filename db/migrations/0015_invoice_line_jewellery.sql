-- 0015_invoice_line_jewellery.sql — per-line jewellery attributes for multi-line bills.
-- item_id is already nullable (loose/manual lines carry no stock item). These columns let
-- a printed GST invoice show gross/net weight, purity, HSN and HUID per line.

ALTER TABLE invoice_line ADD COLUMN IF NOT EXISTS hsn          TEXT;
ALTER TABLE invoice_line ADD COLUMN IF NOT EXISTS purity_label TEXT;
ALTER TABLE invoice_line ADD COLUMN IF NOT EXISTS gross_weight NUMERIC(12,3);
ALTER TABLE invoice_line ADD COLUMN IF NOT EXISTS net_weight   NUMERIC(12,3);
ALTER TABLE invoice_line ADD COLUMN IF NOT EXISTS stone_weight NUMERIC(12,3);
ALTER TABLE invoice_line ADD COLUMN IF NOT EXISTS huid         TEXT;
ALTER TABLE invoice_line ADD COLUMN IF NOT EXISTS making_label TEXT;
ALTER TABLE invoice_line ADD COLUMN IF NOT EXISTS hsn_qty      INTEGER;
