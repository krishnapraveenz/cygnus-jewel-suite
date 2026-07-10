-- 0069_old_jewellery.sql — reframe "old gold" intake as metal-agnostic "old jewellery".
-- The old_gold_lot table already carries any metal_type (gold/silver/platinum) + stones;
-- this migration adds the department (type) grouping used by the register, and records the
-- diamond buyback discount % on bought stones.
--   • department_id  → group each lot as Gold / Silver / Platinum / Diamond Ornaments.
--   • buyback_percent → the flat % of assessed value actually paid for a bought diamond
--     (e.g. 70 / 80); NULL means the value was entered manually.

ALTER TABLE old_gold_lot   ADD COLUMN IF NOT EXISTS department_id   BIGINT REFERENCES department(id);
ALTER TABLE old_gold_stone ADD COLUMN IF NOT EXISTS buyback_percent NUMERIC(5,2);

-- Backfill department for existing lots from metal + diamond presence.
UPDATE old_gold_lot ogl SET department_id = d.id
FROM metal_type mt, department d
WHERE ogl.metal_type_id = mt.id
  AND ogl.department_id IS NULL
  AND d.name = CASE
    WHEN mt.name = 'silver'   THEN 'Silver Ornaments'
    WHEN mt.name = 'platinum' THEN 'Platinum Ornaments'
    WHEN EXISTS (
        SELECT 1 FROM old_gold_stone s JOIN stone_type st ON st.id = s.stone_type_id
        WHERE s.old_gold_lot_id = ogl.id AND st.category = 'diamond'
    ) THEN 'Diamond Ornaments'
    WHEN mt.name = 'gold' THEN 'Gold Ornaments'
    ELSE NULL END;
