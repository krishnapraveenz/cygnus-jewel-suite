-- 0043_scheme_installment_reference.sql — store the payment reference (UPI ref / UTR /
-- cheque no.) on each scheme installment so it prints on the receipt.

ALTER TABLE scheme_installment ADD COLUMN IF NOT EXISTS reference TEXT;
