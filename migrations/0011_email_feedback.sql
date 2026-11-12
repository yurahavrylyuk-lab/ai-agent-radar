-- Immutable delivered-story bindings, current feedback and bounded audit history.
CREATE TABLE email_feedback_stories (
  delivery_key TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 4),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  story_sha256 TEXT NOT NULL CHECK(length(story_sha256)=64 AND story_sha256 NOT GLOB '*[^0-9a-f]*'),
  discovery_key TEXT NOT NULL CHECK(length(discovery_key)=64 AND discovery_key NOT GLOB '*[^0-9a-f]*'),
  display_title TEXT NOT NULL CHECK(length(display_title) BETWEEN 1 AND 256),
  kind TEXT NOT NULL CHECK(kind IN ('analyzed','raw')),
  topic_version INTEGER NOT NULL CHECK(topic_version=1),
  topics_json TEXT NOT NULL CHECK(json_valid(topics_json) AND json_type(topics_json)='array' AND json_array_length(topics_json)<=4),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at>issued_at),
  key_id TEXT NOT NULL CHECK(length(key_id) BETWEEN 1 AND 32),
  relevant_digest TEXT NOT NULL CHECK(length(relevant_digest)=64 AND relevant_digest NOT GLOB '*[^0-9a-f]*'),
  not_relevant_digest TEXT NOT NULL CHECK(length(not_relevant_digest)=64 AND not_relevant_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(delivery_key,slot),
  FOREIGN KEY(delivery_key) REFERENCES email_deliveries(delivery_key)
);

CREATE TRIGGER email_feedback_stories_immutable BEFORE UPDATE ON email_feedback_stories BEGIN
  SELECT RAISE(ABORT,'feedback story bindings are immutable');
END;

CREATE TABLE email_feedback_votes (
  delivery_key TEXT NOT NULL,
  slot INTEGER NOT NULL,
  rating TEXT NOT NULL CHECK(rating IN ('relevant','not_relevant')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 10),
  capability_digest TEXT NOT NULL CHECK(length(capability_digest)=64 AND capability_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(delivery_key,slot),
  FOREIGN KEY(delivery_key,slot) REFERENCES email_feedback_stories(delivery_key,slot) ON DELETE CASCADE
);

CREATE TABLE email_feedback_events (
  delivery_key TEXT NOT NULL,
  slot INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 10),
  previous_rating TEXT CHECK(previous_rating IS NULL OR previous_rating IN ('relevant','not_relevant')),
  new_rating TEXT NOT NULL CHECK(new_rating IN ('relevant','not_relevant')),
  capability_digest TEXT NOT NULL CHECK(length(capability_digest)=64 AND capability_digest NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(delivery_key,slot,revision),
  FOREIGN KEY(delivery_key,slot) REFERENCES email_feedback_stories(delivery_key,slot) ON DELETE CASCADE
);

CREATE TRIGGER email_feedback_vote_insert_audit AFTER INSERT ON email_feedback_votes BEGIN
  INSERT INTO email_feedback_events(delivery_key,slot,revision,previous_rating,new_rating,capability_digest,recorded_at)
  VALUES(NEW.delivery_key,NEW.slot,NEW.revision,NULL,NEW.rating,NEW.capability_digest,NEW.updated_at);
END;

CREATE TRIGGER email_feedback_vote_update_validate BEFORE UPDATE ON email_feedback_votes BEGIN
  SELECT CASE WHEN NEW.delivery_key<>OLD.delivery_key OR NEW.slot<>OLD.slot OR NEW.created_at<>OLD.created_at
    OR NEW.revision<>OLD.revision+1 OR NEW.revision>10 OR NEW.rating=OLD.rating
    THEN RAISE(ABORT,'invalid feedback vote transition') END;
END;

CREATE TRIGGER email_feedback_vote_update_audit AFTER UPDATE ON email_feedback_votes BEGIN
  INSERT INTO email_feedback_events(delivery_key,slot,revision,previous_rating,new_rating,capability_digest,recorded_at)
  VALUES(NEW.delivery_key,NEW.slot,NEW.revision,OLD.rating,NEW.rating,NEW.capability_digest,NEW.updated_at);
END;

CREATE TRIGGER email_feedback_events_immutable_update BEFORE UPDATE ON email_feedback_events BEGIN
  SELECT RAISE(ABORT,'feedback audit is immutable');
END;
CREATE TRIGGER email_feedback_events_immutable_delete BEFORE DELETE ON email_feedback_events
WHEN EXISTS(SELECT 1 FROM email_feedback_stories s WHERE s.delivery_key=OLD.delivery_key AND s.slot=OLD.slot
  AND s.expires_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-150 days'))
BEGIN SELECT RAISE(ABORT,'feedback audit deletion requires binding prune'); END;

CREATE INDEX email_feedback_stories_expiry_idx ON email_feedback_stories(expires_at,delivery_key);
CREATE INDEX email_feedback_votes_updated_idx ON email_feedback_votes(updated_at,delivery_key,slot);
