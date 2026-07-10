-- 0034_party_archived.sql — soft-delete flag. A party with billing/ledger history is
-- archived (hidden) rather than hard-deleted, to preserve referential integrity and audit.

ALTER TABLE party ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
