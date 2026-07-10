-- 0036_two_stage_purity.sql — capture purity at the two stages jewellers actually use:
-- declared (the purity_id the customer claims), tested (XRF surface scan), and assay
-- (post-melt true purity). melt_batch records the expected fine so recovered-vs-expected
-- variance is visible.

ALTER TABLE old_gold_lot ADD COLUMN IF NOT EXISTS tested_fineness INTEGER; -- XRF surface, parts/1000
ALTER TABLE old_gold_lot ADD COLUMN IF NOT EXISTS assay_fineness  INTEGER; -- post-melt true purity

ALTER TABLE melt_batch ADD COLUMN IF NOT EXISTS expected_fine NUMERIC(12,3); -- sum of input lots' fine
