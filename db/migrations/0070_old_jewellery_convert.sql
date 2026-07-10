-- 0070_old_jewellery_convert.sql — convert an old-jewellery lot into a sellable stock item
-- (refurbish → stock). Adds a 'converted' lifecycle state and links the lot to the new item,
-- recording any repair/making cost added on conversion.

ALTER TABLE old_gold_lot DROP CONSTRAINT IF EXISTS old_gold_lot_status_check;
ALTER TABLE old_gold_lot ADD CONSTRAINT old_gold_lot_status_check
    CHECK (status IN ('in_scrap','refined','sold','returned','melted','issued','consumed','converted'));

ALTER TABLE old_gold_lot ADD COLUMN IF NOT EXISTS converted_item_id BIGINT REFERENCES item(id);
ALTER TABLE old_gold_lot ADD COLUMN IF NOT EXISTS repair_cost NUMERIC(14,2);
