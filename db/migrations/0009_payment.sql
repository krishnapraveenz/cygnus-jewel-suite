-- 0009_payment.sql — capture payment mode + cash portion for cash-limit (Sec 269ST)
-- and PAN compliance at billing.

ALTER TABLE invoice ADD COLUMN payment_mode TEXT;          -- cash|card|upi|bank|cheque
ALTER TABLE invoice ADD COLUMN cash_amount  NUMERIC(14,2) NOT NULL DEFAULT 0;
