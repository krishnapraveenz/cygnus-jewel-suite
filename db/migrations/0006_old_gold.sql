-- 0006_old_gold.sql — old gold exchange as a value/cash adjustment (NO GST).
-- GST is charged on the full new item value; old gold only reduces the amount payable.

ALTER TABLE invoice ADD COLUMN old_gold_value NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE invoice ADD COLUMN amount_payable NUMERIC(14,2);

-- Existing invoices: payable = grand_total (no old gold involved).
UPDATE invoice SET amount_payable = grand_total WHERE amount_payable IS NULL;
ALTER TABLE invoice ALTER COLUMN amount_payable SET NOT NULL;
