-- 0030_materials_stones.sql — Stones master (P2 of the Materials manager).
-- Stones are valued by quality (not just weight): diamonds by 4Cs, colored stones
-- by grade. Units are carat or piece (no ratti). HSN: loose diamond 7102, gemstone
-- 7103, pearl 7101, imitation 7117 (set in jewellery they ride under 7113 @ 3%).

CREATE TABLE stone_type (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    category     TEXT NOT NULL CHECK (category IN ('diamond', 'precious', 'semi_precious', 'pearl', 'synthetic')),
    unit         TEXT NOT NULL DEFAULT 'carat' CHECK (unit IN ('carat', 'piece')),
    pricing_mode TEXT NOT NULL DEFAULT 'per_carat_flat'
                   CHECK (pricing_mode IN ('per_carat_quality', 'per_carat_flat', 'per_piece')),
    default_hsn  TEXT,
    gst_rate     NUMERIC(5,2),
    certifiable  BOOLEAN NOT NULL DEFAULT false,
    active       BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Quality grades + their rate (per carat). Used when pricing_mode = 'per_carat_quality'.
CREATE TABLE stone_quality (
    id             BIGSERIAL PRIMARY KEY,
    stone_type_id  BIGINT NOT NULL REFERENCES stone_type(id),
    grade_label    TEXT NOT NULL,          -- e.g. "VS1 / G / 0.30–0.50ct"
    color          TEXT,
    clarity        TEXT,
    size_band      TEXT,
    rate_per_carat NUMERIC(14,2) NOT NULL DEFAULT 0,
    active         BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX stone_quality_type ON stone_quality (stone_type_id);

-- Seed the common stones.
INSERT INTO stone_type (name, category, unit, pricing_mode, default_hsn, gst_rate, certifiable) VALUES
  ('Diamond',        'diamond',   'carat', 'per_carat_quality', '7102', 3.00, true),
  ('Ruby',           'precious',  'carat', 'per_carat_flat',    '7103', 3.00, false),
  ('Emerald',        'precious',  'carat', 'per_carat_flat',    '7103', 3.00, false),
  ('Sapphire',       'precious',  'carat', 'per_carat_flat',    '7103', 3.00, false),
  ('Pearl',          'pearl',     'piece', 'per_piece',         '7101', 3.00, false),
  ('Cubic Zirconia', 'synthetic', 'piece', 'per_piece',         '7117', 3.00, false);
