-- 0039_old_stone_set.sql — old diamond/Navratna ornament intake. A stone-set old piece is
-- gold + diamonds + colored stones; the gold is valued on NET = gross − stone weight, never
-- on the stone weight. Also seed the Navratna colored stones for itemisation.

ALTER TABLE old_gold_lot ADD COLUMN IF NOT EXISTS stone_weight NUMERIC(12,3) NOT NULL DEFAULT 0;

-- Navratna + common colored stones (skip ones already seeded: Diamond, Ruby, Emerald, Sapphire, Pearl).
INSERT INTO stone_type (name, category, unit, pricing_mode, default_hsn, gst_rate, certifiable) VALUES
  ('Coral',          'precious',      'carat', 'per_carat_flat', '7103', 3.00, false),
  ('Yellow Sapphire','precious',      'carat', 'per_carat_flat', '7103', 3.00, false),
  ('Blue Sapphire',  'precious',      'carat', 'per_carat_flat', '7103', 3.00, false),
  ('Hessonite',      'semi_precious', 'carat', 'per_carat_flat', '7103', 3.00, false),
  ('Cat''s Eye',     'semi_precious', 'carat', 'per_carat_flat', '7103', 3.00, false);
