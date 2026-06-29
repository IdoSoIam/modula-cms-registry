CREATE TABLE IF NOT EXISTS translation_cache (
  id TEXT PRIMARY KEY,
  source_locale TEXT NOT NULL,
  target_locale TEXT NOT NULL,
  source_text TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'workers_ai',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS translation_cache_unique_lookup
  ON translation_cache (source_locale, target_locale, source_hash);

CREATE INDEX IF NOT EXISTS translation_cache_source_target_idx
  ON translation_cache (source_locale, target_locale, updated_at);
