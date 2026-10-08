CREATE TABLE x_poll_state (
  author_id TEXT PRIMARY KEY,
  since_id TEXT,
  last_success_at TEXT,
  disabled_reason TEXT
);

CREATE TABLE x_inbox (
  post_id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  story_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'processed', 'filtered', 'expired')),
  edit_ids_json TEXT NOT NULL
);
CREATE INDEX x_inbox_state_created_idx ON x_inbox (state, created_at, post_id);

CREATE TABLE x_request_usage (
  id INTEGER PRIMARY KEY,
  reserved_at TEXT NOT NULL,
  author_id TEXT NOT NULL,
  reserved_posts INTEGER NOT NULL CHECK (reserved_posts = 10),
  reserved_micro_usd INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('reserved', 'success', 'error', 'unknown'))
);
CREATE INDEX x_request_usage_reserved_at_idx ON x_request_usage (reserved_at);
