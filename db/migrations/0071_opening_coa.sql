-- 0071_opening_coa.sql — chart-of-accounts entries needed for go-live opening balances
-- that had no home before: fixed assets (shop/equipment) and loans taken.
INSERT INTO chart_of_account (code, name, type, system, sort_order) VALUES
  ('1500', 'Fixed Assets', 'asset', true, 80),
  ('2500', 'Loans (Secured / Unsecured)', 'liability', true, 160)
ON CONFLICT (code) DO NOTHING;
