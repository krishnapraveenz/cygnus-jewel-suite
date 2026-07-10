-- 0048_item_returned_state.sql — allow items to be marked 'returned' (returned to supplier
-- via a purchase debit note). Without this the purchase-return item update violates the
-- ownership_state check.

ALTER TABLE item DROP CONSTRAINT IF EXISTS item_ownership_state_check;
ALTER TABLE item ADD CONSTRAINT item_ownership_state_check
    CHECK (ownership_state IN
        ('in_stock','on_approval_out','sale_or_return_out','received_in','sold','written_off','returned'));
