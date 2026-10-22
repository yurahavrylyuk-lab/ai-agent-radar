CREATE TABLE monitoring_cycles (
  cycle_id TEXT PRIMARY KEY NOT NULL,
  scheduled_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  source_sha TEXT,
  worker_version TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  phase TEXT NOT NULL CHECK (phase IN ('started','sources_complete','gemini_complete','email_attempting','completed')),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB)) <= 8192),
  CHECK (strftime('%s', scheduled_at) IS NOT NULL AND strftime('%s', started_at) IS NOT NULL AND strftime('%s', updated_at) IS NOT NULL),
  CHECK (started_at >= scheduled_at AND updated_at >= started_at),
  CHECK ((phase = 'completed' AND completed_at IS NOT NULL) OR (phase <> 'completed' AND completed_at IS NULL)),
  CHECK (completed_at IS NULL OR (strftime('%s', completed_at) IS NOT NULL AND completed_at >= started_at)),
  CHECK (source_sha IS NULL OR (length(source_sha)=40 AND source_sha NOT GLOB '*[^0-9a-f]*'))
);

CREATE INDEX monitoring_cycles_scheduled_at_idx ON monitoring_cycles(scheduled_at, cycle_id);

CREATE TABLE monitoring_gemini_attempts (
  cycle_id TEXT NOT NULL REFERENCES monitoring_cycles(cycle_id),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
  usage_id INTEGER NOT NULL UNIQUE REFERENCES gemini_usage(id),
  model TEXT NOT NULL CHECK (model IN ('gemini-3.8-flash','gemini-3.6-flash','gemini-3.5-flash-lite')),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  dispatch_status TEXT NOT NULL CHECK (dispatch_status IN ('not_dispatched','intent','observed')),
  failure_class TEXT NOT NULL DEFAULT 'none' CHECK (failure_class IN ('none','unavailable_503','resource_exhausted_429','unclassified_http_error','timeout','transport_error','response_invalid','accounting_failure')),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  accounting_status TEXT NOT NULL CHECK (accounting_status IN ('reserved','exact','confirmed_zero','transport_ambiguous','unresolved')),
  accounting_error INTEGER NOT NULL CHECK (accounting_error IN (0,1)),
  settlement_status TEXT NOT NULL CHECK (settlement_status IN ('pending','settled','unresolved')),
  retry_decision TEXT NOT NULL CHECK (retry_decision IN ('not_evaluated','retry','stop')),
  retry_reason TEXT NOT NULL CHECK (retry_reason IN ('none','retryable_503','non_retryable','max_attempts','deadline','quota','accounting','telemetry','cancelled')),
  PRIMARY KEY(cycle_id, ordinal),
  CHECK (strftime('%s', started_at) IS NOT NULL AND strftime('%s', updated_at) IS NOT NULL AND updated_at >= started_at),
  CHECK (ended_at IS NULL OR (strftime('%s', ended_at) IS NOT NULL AND ended_at >= started_at)),
  CHECK ((settlement_status='pending' AND accounting_status='reserved' AND ended_at IS NULL) OR
    (settlement_status='settled' AND accounting_status IN ('exact','confirmed_zero') AND ended_at IS NOT NULL) OR
    (settlement_status='unresolved' AND accounting_status IN ('transport_ambiguous','unresolved') AND ended_at IS NOT NULL))
);

CREATE TRIGGER monitoring_cycles_immutable_identity
BEFORE UPDATE ON monitoring_cycles
WHEN NEW.cycle_id IS NOT OLD.cycle_id OR NEW.scheduled_at IS NOT OLD.scheduled_at OR NEW.started_at IS NOT OLD.started_at
  OR NEW.source_sha IS NOT OLD.source_sha OR NEW.worker_version IS NOT OLD.worker_version OR NEW.schema_version IS NOT OLD.schema_version
BEGIN SELECT RAISE(ABORT, 'monitoring cycle identity is immutable'); END;

CREATE TRIGGER monitoring_cycles_monotonic_phase
BEFORE UPDATE ON monitoring_cycles
WHEN (CASE NEW.phase WHEN 'started' THEN 1 WHEN 'sources_complete' THEN 2 WHEN 'gemini_complete' THEN 3 WHEN 'email_attempting' THEN 4 ELSE 5 END)
   < (CASE OLD.phase WHEN 'started' THEN 1 WHEN 'sources_complete' THEN 2 WHEN 'gemini_complete' THEN 3 WHEN 'email_attempting' THEN 4 ELSE 5 END)
BEGIN SELECT RAISE(ABORT, 'monitoring cycle phase cannot regress'); END;

CREATE TRIGGER monitoring_attempt_identity_on_insert
BEFORE INSERT ON monitoring_gemini_attempts
WHEN NOT EXISTS (SELECT 1 FROM gemini_usage u WHERE u.id=NEW.usage_id AND u.model=NEW.model AND u.timestamp=NEW.started_at AND u.accounting_status='reserved')
BEGIN SELECT RAISE(ABORT, 'monitoring attempt does not match reserved usage'); END;

CREATE TRIGGER monitoring_attempt_immutable_identity
BEFORE UPDATE ON monitoring_gemini_attempts
WHEN NEW.cycle_id IS NOT OLD.cycle_id OR NEW.ordinal IS NOT OLD.ordinal OR NEW.usage_id IS NOT OLD.usage_id
  OR NEW.model IS NOT OLD.model OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT, 'monitoring attempt identity is immutable'); END;

CREATE TRIGGER monitoring_attempt_dispatch_progress
BEFORE UPDATE ON monitoring_gemini_attempts
WHEN NOT (
  NEW.dispatch_status = OLD.dispatch_status
  OR (OLD.dispatch_status='not_dispatched' AND NEW.dispatch_status='intent')
  OR (OLD.dispatch_status='intent' AND NEW.dispatch_status='observed')
)
BEGIN SELECT RAISE(ABORT, 'monitoring dispatch state cannot skip or regress'); END;

CREATE TRIGGER monitoring_attempt_protect_delete
BEFORE DELETE ON monitoring_gemini_attempts
BEGIN SELECT RAISE(ABORT, 'monitoring attempt evidence is durable'); END;

CREATE TRIGGER monitoring_attempt_validate_outcome
BEFORE UPDATE ON monitoring_gemini_attempts
WHEN NEW.settlement_status <> 'pending' AND NOT EXISTS (
  SELECT 1 FROM gemini_usage u WHERE u.id=NEW.usage_id AND u.model=NEW.model AND u.timestamp=NEW.started_at AND (
    (NEW.settlement_status='settled' AND NEW.accounting_status=u.accounting_status AND u.accounting_status IN ('exact','confirmed_zero')) OR
    (NEW.settlement_status='unresolved' AND NEW.accounting_status=u.accounting_status AND u.accounting_status='transport_ambiguous')
  )
)
BEGIN SELECT RAISE(ABORT, 'monitoring attempt outcome disagrees with usage'); END;
