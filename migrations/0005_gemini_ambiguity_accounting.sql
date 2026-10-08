ALTER TABLE gemini_usage ADD COLUMN accounting_status TEXT NOT NULL DEFAULT 'legacy'
  CHECK (accounting_status IN (
    'legacy',
    'reserved',
    'exact',
    'confirmed_zero',
    'transport_ambiguous',
    'retired_outside_accounting_windows'
  ));

ALTER TABLE gemini_usage ADD COLUMN ambiguity_reason TEXT
  CHECK (ambiguity_reason IS NULL OR ambiguity_reason IN (
    'timeout',
    'network_error',
    'response_usage_unavailable',
    'abandoned_reservation',
    'settlement_uncertain'
  ));

ALTER TABLE gemini_usage ADD COLUMN settled_at TEXT;
ALTER TABLE gemini_usage ADD COLUMN retired_at TEXT;
ALTER TABLE gemini_usage ADD COLUMN accounting_through TEXT;

UPDATE gemini_usage SET accounting_through = timestamp;

CREATE UNIQUE INDEX gemini_usage_one_unresolved_request
  ON gemini_usage ((1))
  WHERE accounting_status IN ('reserved', 'transport_ambiguous');

CREATE TRIGGER gemini_usage_protect_request_identity
BEFORE UPDATE ON gemini_usage
WHEN NEW.timestamp IS NOT OLD.timestamp
  OR NEW.provider IS NOT OLD.provider
  OR NEW.operation IS NOT OLD.operation
  OR NEW.request_count IS NOT OLD.request_count
  OR NEW.model IS NOT OLD.model
BEGIN
  SELECT RAISE(ABORT, 'Gemini request identity is immutable');
END;

CREATE TRIGGER gemini_usage_validate_accounting_transition
BEFORE UPDATE ON gemini_usage
WHEN NOT (
  (OLD.accounting_status = 'reserved' AND NEW.accounting_status IN ('exact', 'confirmed_zero', 'transport_ambiguous'))
  OR (OLD.accounting_status = 'transport_ambiguous' AND NEW.accounting_status = 'retired_outside_accounting_windows')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid Gemini accounting transition');
END;

CREATE TRIGGER gemini_usage_validate_accounting_interval_insert
BEFORE INSERT ON gemini_usage
WHEN NEW.accounting_through IS NULL
  OR strftime('%s', NEW.accounting_through) IS NULL
  OR NEW.accounting_through < NEW.timestamp
BEGIN
  SELECT RAISE(ABORT, 'invalid Gemini accounting interval');
END;

CREATE TRIGGER gemini_usage_validate_accounting_interval_update
BEFORE UPDATE ON gemini_usage
WHEN NEW.accounting_through IS NULL
  OR strftime('%s', NEW.accounting_through) IS NULL
  OR NEW.accounting_through < NEW.timestamp
  OR NEW.accounting_through < OLD.accounting_through
BEGIN
  SELECT RAISE(ABORT, 'invalid Gemini accounting interval');
END;

CREATE TRIGGER gemini_usage_validate_accounting_insert
BEFORE INSERT ON gemini_usage
WHEN NOT (
  (NEW.accounting_status = 'legacy'
    AND NEW.accounting_through IS NOT NULL
    AND NEW.ambiguity_reason IS NULL AND NEW.settled_at IS NULL AND NEW.retired_at IS NULL)
  OR (NEW.accounting_status = 'reserved'
    AND NEW.input_tokens = 0 AND NEW.output_tokens = 0 AND NEW.total_tokens = 0
    AND NEW.accounting_through = NEW.timestamp
    AND NEW.ambiguity_reason IS NULL AND NEW.settled_at IS NULL AND NEW.retired_at IS NULL)
  OR (NEW.accounting_status = 'exact'
    AND NEW.accounting_through = NEW.settled_at
    AND NEW.ambiguity_reason IS NULL AND NEW.settled_at IS NOT NULL AND NEW.retired_at IS NULL)
  OR (NEW.accounting_status = 'confirmed_zero'
    AND NEW.input_tokens = 0 AND NEW.output_tokens = 0 AND NEW.total_tokens = 0
    AND NEW.accounting_through = NEW.settled_at
    AND NEW.ambiguity_reason IS NULL AND NEW.settled_at IS NOT NULL AND NEW.retired_at IS NULL)
  OR (NEW.accounting_status = 'transport_ambiguous'
    AND NEW.input_tokens = 0 AND NEW.output_tokens = 0 AND NEW.total_tokens = 0
    AND NEW.accounting_through IS NOT NULL
    AND NEW.ambiguity_reason IS NOT NULL AND NEW.settled_at IS NULL AND NEW.retired_at IS NULL)
  OR (NEW.accounting_status = 'retired_outside_accounting_windows'
    AND NEW.input_tokens = 0 AND NEW.output_tokens = 0 AND NEW.total_tokens = 0
    AND NEW.accounting_through IS NOT NULL
    AND NEW.ambiguity_reason IS NOT NULL AND NEW.settled_at IS NULL AND NEW.retired_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid Gemini accounting state');
END;

CREATE TRIGGER gemini_usage_validate_accounting_update
BEFORE UPDATE ON gemini_usage
WHEN NOT (
  (NEW.accounting_status = 'legacy'
    AND NEW.accounting_through IS NOT NULL
    AND NEW.ambiguity_reason IS NULL AND NEW.settled_at IS NULL AND NEW.retired_at IS NULL)
  OR (NEW.accounting_status = 'reserved'
    AND NEW.input_tokens = 0 AND NEW.output_tokens = 0 AND NEW.total_tokens = 0
    AND NEW.accounting_through = NEW.timestamp
    AND NEW.ambiguity_reason IS NULL AND NEW.settled_at IS NULL AND NEW.retired_at IS NULL)
  OR (NEW.accounting_status = 'exact'
    AND NEW.accounting_through = NEW.settled_at
    AND NEW.ambiguity_reason IS NULL AND NEW.settled_at IS NOT NULL AND NEW.retired_at IS NULL)
  OR (NEW.accounting_status = 'confirmed_zero'
    AND NEW.input_tokens = 0 AND NEW.output_tokens = 0 AND NEW.total_tokens = 0
    AND NEW.accounting_through = NEW.settled_at
    AND NEW.ambiguity_reason IS NULL AND NEW.settled_at IS NOT NULL AND NEW.retired_at IS NULL)
  OR (NEW.accounting_status = 'transport_ambiguous'
    AND NEW.input_tokens = 0 AND NEW.output_tokens = 0 AND NEW.total_tokens = 0
    AND NEW.accounting_through IS NOT NULL
    AND NEW.ambiguity_reason IS NOT NULL AND NEW.settled_at IS NULL AND NEW.retired_at IS NULL)
  OR (NEW.accounting_status = 'retired_outside_accounting_windows'
    AND NEW.input_tokens = 0 AND NEW.output_tokens = 0 AND NEW.total_tokens = 0
    AND NEW.accounting_through IS NOT NULL
    AND NEW.ambiguity_reason IS NOT NULL AND NEW.settled_at IS NULL AND NEW.retired_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid Gemini accounting state');
END;
