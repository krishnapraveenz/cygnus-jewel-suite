-- 0041_purchase_stone_line.sql — allow loose-stone / diamond purchase lines.
-- Widens the purchase_bill_line.pricing_mode check to include 'stone' (no metal, books
-- the stones into loose-stone inventory).

ALTER TABLE purchase_bill_line DROP CONSTRAINT IF EXISTS purchase_bill_line_pricing_mode_check;
ALTER TABLE purchase_bill_line ADD CONSTRAINT purchase_bill_line_pricing_mode_check
    CHECK (pricing_mode IN ('fixed_cost','weight_rate','touch','stone'));
