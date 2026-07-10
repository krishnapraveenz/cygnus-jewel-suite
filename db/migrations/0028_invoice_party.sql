-- 0028_invoice_party.sql — link invoices to the unified party, so a sale posts to the
-- party's cash/metal ledger and the e-invoice buyer is first-class. Back-fill existing
-- invoices' party_id from their customer's linked party.

ALTER TABLE invoice ADD COLUMN IF NOT EXISTS party_id BIGINT REFERENCES party(id);

UPDATE invoice i SET party_id = c.party_id
FROM customer c
WHERE i.customer_id = c.id AND i.party_id IS NULL AND c.party_id IS NOT NULL;
