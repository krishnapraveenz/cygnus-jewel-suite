-- 0046_backfill_advance_no.sql — give every existing advance a continuous ADV number
-- and make the 'advance' document series continue after them.

-- Number all advances in id order: ADV-2627-0001, 0002, …
WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY id) AS rn FROM customer_advance
)
UPDATE customer_advance a
   SET advance_no = 'ADV-2627-' || lpad(o.rn::text, 4, '0')
  FROM ordered o
 WHERE a.id = o.id;

-- Ensure the series exists and its next number continues after the backfilled ones.
INSERT INTO document_series (doc_type, fy, series_code, prefix, suffix, pad_width, next_no)
VALUES ('advance', '2026-27', 'T1', 'ADV-2627-', '', 4,
        (SELECT count(*) + 1 FROM customer_advance))
ON CONFLICT (doc_type, fy, series_code) DO UPDATE
   SET prefix  = 'ADV-2627-',
       next_no = GREATEST(document_series.next_no, EXCLUDED.next_no);
