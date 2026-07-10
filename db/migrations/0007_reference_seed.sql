-- 0007_reference_seed.sql — bootstrap reference data needed for the app to function:
-- a default branch, the metal types, and standard purities. (Daily rates are set via the
-- app, not seeded here.)

INSERT INTO branch (company_id, name, type) VALUES (1, 'Main Showroom', 'showroom');

INSERT INTO metal_type (name) VALUES ('gold'), ('silver'), ('platinum');

INSERT INTO purity (metal_type_id, label, karat, fineness) VALUES
  ((SELECT id FROM metal_type WHERE name = 'gold'),     '24K',   24.00, 999),
  ((SELECT id FROM metal_type WHERE name = 'gold'),     '22K',   22.00, 916),
  ((SELECT id FROM metal_type WHERE name = 'gold'),     '18K',   18.00, 750),
  ((SELECT id FROM metal_type WHERE name = 'gold'),     '14K',   14.00, 585),
  ((SELECT id FROM metal_type WHERE name = 'gold'),     '999.9', NULL,  999),
  ((SELECT id FROM metal_type WHERE name = 'silver'),   '999',   NULL,  999),
  ((SELECT id FROM metal_type WHERE name = 'silver'),   '925',   NULL,  925),
  ((SELECT id FROM metal_type WHERE name = 'platinum'), '950',   NULL,  950);
