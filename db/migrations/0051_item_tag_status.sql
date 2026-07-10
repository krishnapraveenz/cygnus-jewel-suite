-- 0051_item_tag_status.sql — allow deferred tagging of itemised pieces.
-- 'tagged'   : barcode assigned and (intended) physically labelled — the default, and what
--              every existing item is.
-- 'untagged' : item recorded (stock + money correct) but its label is not printed yet;
--              it appears under Tagging → Pending tags to print later.
ALTER TABLE item ADD COLUMN IF NOT EXISTS tag_status TEXT NOT NULL DEFAULT 'tagged'
    CHECK (tag_status IN ('tagged','untagged'));
CREATE INDEX IF NOT EXISTS item_tag_status ON item (tag_status);
