-- 0042_customer_party_backfill.sql — finish unifying customers into the Party model.
-- 0027 back-filled customers that existed then; this catches any created since (the
-- Customers screen / sales quick-add wrote only to `customer` until now). Idempotent.

-- Create a party for each customer that still has no link.
INSERT INTO party (branch_id, display_name, party_kind, phone, pan, gst_registration_type)
SELECT c.branch_id, c.name, 'individual', c.phone, c.pan, 'consumer'
FROM customer c
WHERE c.party_id IS NULL;

-- Link those customers to the freshly-created party rows (match on name + phone + pan).
UPDATE customer c SET party_id = p.id
FROM party p
WHERE c.party_id IS NULL
  AND p.display_name = c.name
  AND p.phone IS NOT DISTINCT FROM c.phone
  AND p.pan IS NOT DISTINCT FROM c.pan;

-- Ensure the 'customer' role exists for every linked customer.
INSERT INTO party_role (party_id, role)
SELECT party_id, 'customer' FROM customer WHERE party_id IS NOT NULL
ON CONFLICT DO NOTHING;
