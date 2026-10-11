-- Add current cost per formula unit for inventory items.
-- Safe to run more than once; src/db/index.js also applies this migration on startup.
ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS unit_price DOUBLE PRECISION NOT NULL DEFAULT 0;
