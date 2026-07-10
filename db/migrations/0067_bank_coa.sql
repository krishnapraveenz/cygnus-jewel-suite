-- 0067_bank_coa.sql — per-bank-account ledger accounts in the Chart of Accounts.
-- Each bank_account gets its own asset ledger (code '1010.<id>') so Trial Balance,
-- Balance Sheet and account Ledger show each bank separately. The generic 'Bank
-- Accounts' (1010) becomes the group control (typically nil once accounts exist).
ALTER TABLE bank_account ADD COLUMN IF NOT EXISTS coa_account_id BIGINT REFERENCES chart_of_account(id);

INSERT INTO chart_of_account (code, name, type, system, sort_order)
SELECT '1010.' || ba.id, ba.name, 'asset', true, 21
FROM bank_account ba
WHERE NOT EXISTS (SELECT 1 FROM chart_of_account c WHERE c.code = '1010.' || ba.id);

UPDATE bank_account ba SET coa_account_id = c.id
FROM chart_of_account c
WHERE c.code = '1010.' || ba.id AND ba.coa_account_id IS NULL;
