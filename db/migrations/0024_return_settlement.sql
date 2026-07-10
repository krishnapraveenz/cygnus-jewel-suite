-- 0024_return_settlement.sql — settings + old-gold 'returned' state for return settlement.

INSERT INTO app_setting (key, value) VALUES
    ('cash_rate_deduction_percent', '8'),   -- cash buy-back rate = exchange rate − this %
    ('cash_refund_limit', '20000')          -- refund as cash up to this, else bank transfer
    ON CONFLICT (key) DO NOTHING;

-- Allow an old-gold lot to be handed back to the customer on a return.
ALTER TABLE old_gold_lot DROP CONSTRAINT IF EXISTS old_gold_lot_status_check;
ALTER TABLE old_gold_lot ADD CONSTRAINT old_gold_lot_status_check
    CHECK (status IN ('in_scrap', 'refined', 'sold', 'returned'));
