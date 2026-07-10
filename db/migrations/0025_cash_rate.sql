-- 0025_cash_rate.sql — per-purity cash (buy-back) rate, set in daily rate entry alongside
-- buy (exchange) and sell. Old-gold cash settlement on a return uses this rate.

ALTER TABLE metal_rate ADD COLUMN IF NOT EXISTS cash_rate NUMERIC(14,2);
