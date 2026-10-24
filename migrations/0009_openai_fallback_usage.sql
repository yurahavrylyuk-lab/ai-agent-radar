CREATE TABLE openai_fallback_usage (
  cycle_id TEXT PRIMARY KEY NOT NULL REFERENCES monitoring_cycles(cycle_id),
  attempt_id TEXT UNIQUE NOT NULL,
  scheduled_at TEXT UNIQUE NOT NULL,
  model TEXT NOT NULL CHECK (model = 'gpt-6-luna'),
  reserved_at TEXT NOT NULL,
  accounting_through TEXT NOT NULL,
  started_at TEXT,
  settled_at TEXT,
  request_count INTEGER NOT NULL CHECK (request_count = 1),
  reserved_input INTEGER NOT NULL CHECK (reserved_input = 12288),
  reserved_output INTEGER NOT NULL CHECK (reserved_output = 12288),
  reserved_total INTEGER NOT NULL CHECK (reserved_total = 24576),
  state TEXT NOT NULL CHECK (state IN ('reserved','exact','unknown','cancelled_pre_dispatch')),
  dispatch_status TEXT NOT NULL CHECK (dispatch_status IN ('not_dispatched','intent','observed')),
  input_tokens INTEGER CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens INTEGER CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
  total_tokens INTEGER CHECK (total_tokens BETWEEN 0 AND 9007199254740991),
  failure_class TEXT NOT NULL CHECK (failure_class IN ('none','not_admitted','timeout','transport_error','http_failure','invalid_response','usage_unknown','accounting_failure')),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 110000),
  budget_anomaly INTEGER NOT NULL DEFAULT 0 CHECK (budget_anomaly IN (0,1)),
  CHECK (strftime('%s', reserved_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', reserved_at) = reserved_at),
  CHECK (strftime('%s', accounting_through) IS NOT NULL AND accounting_through >= reserved_at),
  CHECK (started_at IS NULL OR (strftime('%s', started_at) IS NOT NULL AND started_at >= reserved_at AND accounting_through >= started_at)),
  CHECK (settled_at IS NULL OR (strftime('%s', settled_at) IS NOT NULL AND settled_at >= reserved_at AND accounting_through >= settled_at)),
  CHECK ((state='reserved' AND settled_at IS NULL AND input_tokens IS NULL AND output_tokens IS NULL AND total_tokens IS NULL AND failure_class='none' AND budget_anomaly=0)
    OR (state='unknown' AND settled_at IS NOT NULL AND input_tokens IS NULL AND output_tokens IS NULL AND total_tokens IS NULL AND dispatch_status IN ('intent','observed'))
    OR (state='exact' AND settled_at IS NOT NULL AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND total_tokens=input_tokens+output_tokens AND total_tokens>=input_tokens AND total_tokens>=output_tokens AND dispatch_status IN ('intent','observed') AND budget_anomaly=((input_tokens>reserved_input) OR (output_tokens>reserved_output) OR (total_tokens>reserved_total)))
    OR (state='cancelled_pre_dispatch' AND settled_at IS NOT NULL AND input_tokens IS NULL AND output_tokens IS NULL AND total_tokens IS NULL AND dispatch_status IN ('not_dispatched','intent')))
);

CREATE UNIQUE INDEX openai_fallback_one_unresolved ON openai_fallback_usage((1)) WHERE state IN ('reserved','unknown');
CREATE INDEX openai_fallback_accounting_window ON openai_fallback_usage(reserved_at, accounting_through);

CREATE TRIGGER openai_fallback_validate_insert
BEFORE INSERT ON openai_fallback_usage
WHEN NOT EXISTS (SELECT 1 FROM monitoring_cycles c WHERE c.cycle_id=NEW.cycle_id AND c.scheduled_at=NEW.scheduled_at)
  OR NEW.state<>'reserved' OR NEW.dispatch_status<>'not_dispatched' OR NEW.started_at IS NOT NULL OR NEW.settled_at IS NOT NULL
  OR NEW.input_tokens IS NOT NULL OR NEW.output_tokens IS NOT NULL OR NEW.total_tokens IS NOT NULL OR NEW.failure_class<>'none' OR NEW.budget_anomaly<>0
BEGIN SELECT RAISE(ABORT, 'invalid OpenAI fallback reservation'); END;

CREATE TRIGGER openai_fallback_validate_update
BEFORE UPDATE ON openai_fallback_usage
WHEN NEW.cycle_id IS NOT OLD.cycle_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.scheduled_at IS NOT OLD.scheduled_at
  OR NEW.model IS NOT OLD.model OR NEW.reserved_at IS NOT OLD.reserved_at OR NEW.request_count IS NOT OLD.request_count
  OR NEW.reserved_input IS NOT OLD.reserved_input OR NEW.reserved_output IS NOT OLD.reserved_output OR NEW.reserved_total IS NOT OLD.reserved_total
  OR NEW.accounting_through < OLD.accounting_through OR (OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at)
  OR OLD.state<>'reserved'
  OR NOT (NEW.state=OLD.state OR NEW.state IN ('exact','unknown','cancelled_pre_dispatch'))
  OR NOT (NEW.dispatch_status=OLD.dispatch_status OR (OLD.dispatch_status='not_dispatched' AND NEW.dispatch_status='intent') OR (OLD.dispatch_status='intent' AND NEW.dispatch_status='observed'))
  OR (NEW.state IN ('exact','unknown') AND NEW.dispatch_status='not_dispatched')
  OR (NEW.state='cancelled_pre_dispatch' AND NEW.dispatch_status='observed')
BEGIN SELECT RAISE(ABORT, 'invalid OpenAI fallback transition'); END;

CREATE TRIGGER openai_fallback_protect_delete
BEFORE DELETE ON openai_fallback_usage
BEGIN SELECT RAISE(ABORT, 'OpenAI fallback evidence is durable'); END;
