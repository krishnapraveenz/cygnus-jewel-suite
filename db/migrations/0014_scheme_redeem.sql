-- 0014_scheme_redeem.sql — apply a matured scheme as a tender on a sale.
-- scheme_credit reduces the amount payable; redeemed_scheme_id links the scheme.

ALTER TABLE invoice ADD COLUMN scheme_credit      NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE invoice ADD COLUMN redeemed_scheme_id BIGINT REFERENCES scheme(id);
