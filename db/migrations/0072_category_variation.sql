-- 0072_category_variation.sql — product variations (sub-types) under each category.
-- e.g. Category "Necklace" → variations: Choker, Princess, Matinee, Long Chain
--      Category "Ring" → variations: Solitaire, Band, Cocktail, Engagement

CREATE TABLE IF NOT EXISTS category_variation (
    id            BIGSERIAL PRIMARY KEY,
    category_id   BIGINT NOT NULL REFERENCES item_category(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    active        BOOLEAN NOT NULL DEFAULT true,
    sort_order    INT NOT NULL DEFAULT 100,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (category_id, name)
);
CREATE INDEX IF NOT EXISTS category_variation_cat ON category_variation(category_id);

-- Link items to their variation (optional — backwards compatible).
ALTER TABLE item ADD COLUMN IF NOT EXISTS variation_id BIGINT REFERENCES category_variation(id);
