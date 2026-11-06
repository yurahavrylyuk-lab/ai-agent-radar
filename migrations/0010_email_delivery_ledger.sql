CREATE TABLE email_deliveries (
  delivery_key TEXT PRIMARY KEY NOT NULL,
  logical_date TEXT UNIQUE NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','attempting','ambiguous','accepted','confirmed_failed')),
  payload_version INTEGER CHECK (payload_version IS NULL OR payload_version = 1),
  content_json TEXT,
  payload_sha256 TEXT NOT NULL,
  mode TEXT CHECK (mode IS NULL OR mode IN ('normal','degraded','status_only')),
  reason TEXT CHECK (reason IS NULL OR reason IN (
    'selected','no_eligible_stories','ai_unavailable','ai_no_selections','discovery_unavailable',
    'history_unavailable','preparation_unavailable','persistence_unavailable'
  )),
  aliases_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  first_provider_attempt_at TEXT,
  last_provider_attempt_at TEXT,
  retry_before TEXT,
  claim_token TEXT,
  claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  lease_until TEXT,
  dispatch_evidence_json TEXT NOT NULL DEFAULT '[]',
  provider_message_id TEXT,
  accepted_at TEXT,
  reconciled_at TEXT,
  last_reason TEXT NOT NULL CHECK (last_reason IN (
    'prepared','claimed','dispatch_admitted','cancelled_before_dispatch','provider_accepted','provider_rejected',
    'provider_ambiguous','payload_conflict','already_accepted','in_progress','recovery_required','ledger_unavailable',
    'configuration_payload_mismatch','history_pending','history_reconciled','integrity_hold'
  )),
  CHECK (length(delivery_key) = 23 AND delivery_key = 'daily-digest/' || logical_date),
  CHECK (length(logical_date) = 10 AND date(logical_date) = logical_date),
  CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (strftime('%s', created_at) IS NOT NULL AND strftime('%s', updated_at) IS NOT NULL AND updated_at >= created_at),
  CHECK (first_provider_attempt_at IS NULL OR strftime('%s', first_provider_attempt_at) IS NOT NULL),
  CHECK (last_provider_attempt_at IS NULL OR strftime('%s', last_provider_attempt_at) IS NOT NULL),
  CHECK (retry_before IS NULL OR strftime('%s', retry_before) IS NOT NULL),
  CHECK (lease_until IS NULL OR strftime('%s', lease_until) IS NOT NULL),
  CHECK (accepted_at IS NULL OR strftime('%s', accepted_at) IS NOT NULL),
  CHECK (reconciled_at IS NULL OR strftime('%s', reconciled_at) IS NOT NULL),
  CHECK ((claim_token IS NULL AND lease_until IS NULL) OR (claim_token IS NOT NULL AND length(CAST(claim_token AS BLOB)) BETWEEN 1 AND 256 AND lease_until IS NOT NULL)),
  CHECK (json_valid(dispatch_evidence_json) AND json_type(dispatch_evidence_json) = 'array'
    AND json_array_length(dispatch_evidence_json) BETWEEN 0 AND 3
    AND length(CAST(dispatch_evidence_json AS BLOB)) <= 4096),
  CHECK (
    (json_array_length(dispatch_evidence_json) = 0 AND first_provider_attempt_at IS NULL AND last_provider_attempt_at IS NULL AND retry_before IS NULL)
    OR
    (json_array_length(dispatch_evidence_json) BETWEEN 1 AND 3
      AND first_provider_attempt_at IS NOT NULL AND last_provider_attempt_at IS NOT NULL AND retry_before IS NOT NULL
      AND last_provider_attempt_at >= first_provider_attempt_at AND retry_before > first_provider_attempt_at)
  ),
  CHECK (
    (content_json IS NOT NULL AND payload_version = 1 AND mode IS NOT NULL AND reason IS NOT NULL
      AND json_valid(content_json) AND json_type(content_json) = 'object'
      AND length(CAST(content_json AS BLOB)) <= 278528
      AND aliases_json IS NOT NULL AND json_valid(aliases_json) AND json_type(aliases_json) = 'array'
      AND json_array_length(aliases_json) BETWEEN 0 AND 128 AND length(CAST(aliases_json AS BLOB)) <= 131072)
    OR
    (content_json IS NULL AND payload_version IS NULL AND mode IS NULL AND reason IS NULL AND aliases_json IS NULL
      AND state = 'accepted' AND reconciled_at IS NOT NULL)
  ),
  CHECK (
    (state = 'accepted' AND provider_message_id IS NOT NULL AND length(CAST(provider_message_id AS BLOB)) BETWEEN 1 AND 256
      AND accepted_at IS NOT NULL)
    OR
    (state <> 'accepted' AND provider_message_id IS NULL AND accepted_at IS NULL AND reconciled_at IS NULL)
  )
);

CREATE INDEX email_deliveries_accepted_unreconciled_idx
  ON email_deliveries(accepted_at, delivery_key)
  WHERE state = 'accepted' AND reconciled_at IS NULL;

CREATE TRIGGER email_deliveries_immutable_payload
BEFORE UPDATE ON email_deliveries
WHEN NEW.delivery_key IS NOT OLD.delivery_key
  OR NEW.logical_date IS NOT OLD.logical_date
  OR NEW.payload_sha256 IS NOT OLD.payload_sha256
  OR (OLD.content_json IS NOT NULL AND NEW.content_json IS NOT OLD.content_json)
  OR (OLD.payload_version IS NOT NULL AND NEW.payload_version IS NOT OLD.payload_version)
  OR (OLD.mode IS NOT NULL AND NEW.mode IS NOT OLD.mode)
  OR (OLD.reason IS NOT NULL AND NEW.reason IS NOT OLD.reason)
  OR (OLD.aliases_json IS NOT NULL AND NEW.aliases_json IS NOT OLD.aliases_json)
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.claim_generation < OLD.claim_generation
  OR (OLD.first_provider_attempt_at IS NOT NULL AND NEW.first_provider_attempt_at IS NOT OLD.first_provider_attempt_at
    AND NOT (OLD.state='attempting' AND NEW.state='prepared' AND json_array_length(OLD.dispatch_evidence_json)=1
      AND json_array_length(NEW.dispatch_evidence_json)=0 AND NEW.first_provider_attempt_at IS NULL))
  OR (OLD.retry_before IS NOT NULL AND NEW.retry_before IS NOT OLD.retry_before
    AND NOT (OLD.state='attempting' AND NEW.state='prepared' AND json_array_length(OLD.dispatch_evidence_json)=1
      AND json_array_length(NEW.dispatch_evidence_json)=0 AND NEW.retry_before IS NULL))
  OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS NOT OLD.accepted_at)
BEGIN
  SELECT RAISE(ABORT, 'email delivery identity and evidence are immutable');
END;

CREATE TRIGGER email_deliveries_validate_transition
BEFORE UPDATE ON email_deliveries
WHEN NOT (
  NEW.state = OLD.state
  OR (OLD.state = 'prepared' AND NEW.state = 'attempting')
  OR (OLD.state = 'attempting' AND NEW.state IN ('prepared','ambiguous','accepted','confirmed_failed'))
  OR (OLD.state = 'ambiguous' AND NEW.state IN ('attempting','accepted'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid email delivery transition');
END;

CREATE TRIGGER email_deliveries_protect_delete
BEFORE DELETE ON email_deliveries
BEGIN
  SELECT RAISE(ABORT, 'email delivery evidence is durable');
END;
