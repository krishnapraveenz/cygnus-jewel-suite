-- 0062_cash_short_over.sql — ledger account for day-close cash variance.
-- Shortage (counted < expected) debits this (expense); excess credits it.
INSERT INTO chart_of_account (code, name, type, system, sort_order) VALUES
  ('5995','Cash Short / Over','expense',true,485)
ON CONFLICT (code) DO NOTHING;
