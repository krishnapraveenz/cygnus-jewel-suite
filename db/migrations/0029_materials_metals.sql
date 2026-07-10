-- 0029_materials_metals.sql — Metals master (P1 of the Materials manager).
-- Extend metal_type with HSN/GST/hallmark/active and allow arbitrary metal names
-- (e.g. palladium). purity gets an active flag so grades can be enabled/disabled.

ALTER TABLE metal_type ADD COLUMN IF NOT EXISTS default_hsn         TEXT;
ALTER TABLE metal_type ADD COLUMN IF NOT EXISTS gst_rate            NUMERIC(5,2);
ALTER TABLE metal_type ADD COLUMN IF NOT EXISTS hallmark_applicable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE metal_type ADD COLUMN IF NOT EXISTS active              BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE purity     ADD COLUMN IF NOT EXISTS active              BOOLEAN NOT NULL DEFAULT true;

-- Allow new metal types beyond the original gold/silver/platinum.
ALTER TABLE metal_type DROP CONSTRAINT IF EXISTS metal_type_name_check;

-- Seed sensible defaults: jewellery HSN 7113 @ 3%; gold & silver are hallmarked.
UPDATE metal_type SET default_hsn = COALESCE(default_hsn, '7113'),
                      gst_rate    = COALESCE(gst_rate, 3.00);
UPDATE metal_type SET hallmark_applicable = true WHERE name IN ('gold', 'silver');
