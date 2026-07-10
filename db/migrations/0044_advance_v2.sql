-- 0044_advance_v2.sql — richer customer advances:
--  • amount advances (cash booking, optional due date), and
--  • metal advances (book N grams at a locked rate; pay 10/25/50/100% now).
-- Adds an explicit 'closed' status so a specific advance can be settled from the list.

ALTER TABLE customer_advance ADD COLUMN IF NOT EXISTS advance_type  TEXT NOT NULL DEFAULT 'amount'
                               CHECK (advance_type IN ('amount','metal'));
ALTER TABLE customer_advance ADD COLUMN IF NOT EXISTS metal_type_id BIGINT REFERENCES metal_type(id);
ALTER TABLE customer_advance ADD COLUMN IF NOT EXISTS purity_id     BIGINT REFERENCES purity(id);
ALTER TABLE customer_advance ADD COLUMN IF NOT EXISTS booked_weight NUMERIC(12,3) NOT NULL DEFAULT 0;
ALTER TABLE customer_advance ADD COLUMN IF NOT EXISTS rate_locked   NUMERIC(14,2);
ALTER TABLE customer_advance ADD COLUMN IF NOT EXISTS percent       NUMERIC(6,2);
ALTER TABLE customer_advance ADD COLUMN IF NOT EXISTS due_date      DATE;

ALTER TABLE customer_advance DROP CONSTRAINT IF EXISTS customer_advance_status_check;
ALTER TABLE customer_advance ADD CONSTRAINT customer_advance_status_check
    CHECK (status IN ('active','consumed','refunded','closed'));
