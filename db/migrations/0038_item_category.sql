-- 0038_item_category.sql — ornament category taxonomy (material-agnostic types) so stock
-- can be grouped by category (Finger Ring, Bangle, Necklace, Stud, Chain, Anklet…) in
-- addition to metal/purity. Metal grouping uses the existing metal_type + purity.

CREATE TABLE item_category (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    active     BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 100
);

INSERT INTO item_category (name, sort_order) VALUES
  ('Finger Ring', 10), ('Bangle', 20), ('Kada', 21), ('Bracelet', 22),
  ('Necklace', 30), ('Haram', 31), ('Chain', 32),
  ('Pendant', 40), ('Pendant Set', 41), ('Mangalsutra', 45),
  ('Earrings', 50), ('Studs', 51), ('Drops', 52), ('Jhumka', 53),
  ('Anklet', 60), ('Nose Pin', 61), ('Maang Tikka', 62), ('Waist Chain', 63),
  ('Bajubandh', 64), ('Vanki', 65), ('Coin', 70), ('Bar', 71), ('Other', 99);

ALTER TABLE item ADD COLUMN IF NOT EXISTS category_id BIGINT REFERENCES item_category(id);
