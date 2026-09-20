CREATE TABLE IF NOT EXISTS discoveries (
  normalized_url TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  analysis_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  normalized_url TEXT NOT NULL,
  channel TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  provider_message_id TEXT,
  PRIMARY KEY (normalized_url, channel)
);

CREATE TABLE IF NOT EXISTS brave_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'brave'),
  operation TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0)
);

CREATE TABLE IF NOT EXISTS gemini_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'gemini'),
  operation TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count = 1),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  total_tokens INTEGER NOT NULL CHECK (total_tokens >= input_tokens + output_tokens)
);

CREATE TABLE IF NOT EXISTS gemini_usage_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  usage_unknown INTEGER NOT NULL CHECK (usage_unknown IN (0, 1))
);

INSERT OR IGNORE INTO gemini_usage_state (id, usage_unknown) VALUES (1, 0);
