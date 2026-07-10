-- 0018_credit_note_reason_detail.sql — keep `reason` as the GST category
-- (return/rate_diff/cancellation/other) and store the human/preset reason
-- (e.g. "Manufacturing defect", "Not satisfied") separately.

ALTER TABLE credit_note ADD COLUMN IF NOT EXISTS reason_detail TEXT;
