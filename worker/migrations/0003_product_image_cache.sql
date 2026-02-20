CREATE TABLE IF NOT EXISTS product_image_cache (
  canonical_key TEXT PRIMARY KEY,
  image_url TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_image_cache_updated
  ON product_image_cache(updated_at DESC);
