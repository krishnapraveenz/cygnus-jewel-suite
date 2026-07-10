-- 0020_old_gold_fine_weight.sql — track the PURE (fine) metal content of an old-gold lot.
-- Physical stock = gross_weight (what we actually hold). net_weight is only the valuation
-- basis for what we pay the customer. fine_weight = gross × fineness/1000 (refining basis).

ALTER TABLE old_gold_lot ADD COLUMN IF NOT EXISTS fine_weight NUMERIC(12,3);
