-- 0013_scheme_gram.sql — second scheme type: GRAM accumulation (rate averaging).
-- Each cash installment is converted to gold weight at that day's rate; grams accumulate.
-- At maturity: average_rate = total_paid / total_grams, and gold is billed at that average.
-- (Existing schemes default to the 'value' type — unchanged.)

ALTER TABLE scheme ADD COLUMN scheme_type   TEXT NOT NULL DEFAULT 'value'
                     CHECK (scheme_type IN ('value', 'gram'));
ALTER TABLE scheme ADD COLUMN metal_type_id BIGINT REFERENCES metal_type(id);
ALTER TABLE scheme ADD COLUMN purity_id     BIGINT REFERENCES purity(id);
ALTER TABLE scheme ADD COLUMN total_grams   NUMERIC(12,3) NOT NULL DEFAULT 0;
ALTER TABLE scheme ADD COLUMN average_rate  NUMERIC(14,2);

ALTER TABLE scheme_installment ADD COLUMN rate_used NUMERIC(14,2);
ALTER TABLE scheme_installment ADD COLUMN grams     NUMERIC(12,3);
