CREATE TABLE gemini_row22_recovery_guard (
  verified INTEGER NOT NULL
    CONSTRAINT "row 22 recovery precondition failed" CHECK (verified = 1)
);

INSERT INTO gemini_row22_recovery_guard (verified)
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM gemini_usage
  WHERE id = 22
    AND timestamp = '2026-10-12T08:00:10.882Z'
    AND provider = 'gemini'
    AND operation = 'analysis'
    AND request_count = 1
    AND input_tokens = 0
    AND output_tokens = 0
    AND total_tokens = 0
    AND model = 'gemini-3.8-flash'
    AND accounting_through = '2026-10-12T08:00:10.947Z'
    AND retired_at IS NULL
    AND (
      (accounting_status = 'transport_ambiguous'
        AND ambiguity_reason = 'abandoned_reservation'
        AND settled_at IS NULL)
      OR
      (accounting_status = 'confirmed_zero'
        AND ambiguity_reason IS NULL
        AND settled_at = '2026-10-12T08:00:10.947Z')
    )
) THEN 1 ELSE 0 END;

DROP TABLE gemini_row22_recovery_guard;

DROP TRIGGER gemini_usage_validate_accounting_transition;

CREATE TRIGGER gemini_usage_validate_accounting_transition
BEFORE UPDATE ON gemini_usage
WHEN NOT (
  (OLD.accounting_status = 'reserved' AND NEW.accounting_status IN ('exact', 'confirmed_zero', 'transport_ambiguous'))
  OR (OLD.accounting_status = 'transport_ambiguous' AND NEW.accounting_status = 'retired_outside_accounting_windows')
  OR (
    OLD.id = 22 AND NEW.id = 22
    AND OLD.timestamp = '2026-10-12T08:00:10.882Z' AND NEW.timestamp = OLD.timestamp
    AND OLD.provider = 'gemini' AND NEW.provider = OLD.provider
    AND OLD.operation = 'analysis' AND NEW.operation = OLD.operation
    AND OLD.request_count = 1 AND NEW.request_count = OLD.request_count
    AND OLD.input_tokens = 0 AND NEW.input_tokens = 0
    AND OLD.output_tokens = 0 AND NEW.output_tokens = 0
    AND OLD.total_tokens = 0 AND NEW.total_tokens = 0
    AND OLD.model = 'gemini-3.8-flash' AND NEW.model = OLD.model
    AND OLD.accounting_status = 'transport_ambiguous'
    AND OLD.ambiguity_reason = 'abandoned_reservation'
    AND OLD.settled_at IS NULL AND OLD.retired_at IS NULL
    AND OLD.accounting_through = '2026-10-12T08:00:10.947Z'
    AND NEW.accounting_status = 'confirmed_zero'
    AND NEW.ambiguity_reason IS NULL
    AND NEW.settled_at = '2026-10-12T08:00:10.947Z'
    AND NEW.retired_at IS NULL
    AND NEW.accounting_through = OLD.accounting_through
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid Gemini accounting transition');
END;

UPDATE gemini_usage
SET accounting_status = 'confirmed_zero',
    ambiguity_reason = NULL,
    settled_at = '2026-10-12T08:00:10.947Z'
WHERE id = 22
  AND timestamp = '2026-10-12T08:00:10.882Z'
  AND provider = 'gemini'
  AND operation = 'analysis'
  AND request_count = 1
  AND input_tokens = 0
  AND output_tokens = 0
  AND total_tokens = 0
  AND model = 'gemini-3.8-flash'
  AND accounting_status = 'transport_ambiguous'
  AND ambiguity_reason = 'abandoned_reservation'
  AND settled_at IS NULL
  AND retired_at IS NULL
  AND accounting_through = '2026-10-12T08:00:10.947Z';

DROP TRIGGER gemini_usage_validate_accounting_transition;

CREATE TRIGGER gemini_usage_validate_accounting_transition
BEFORE UPDATE ON gemini_usage
WHEN NOT (
  (OLD.accounting_status = 'reserved' AND NEW.accounting_status IN ('exact', 'confirmed_zero', 'transport_ambiguous'))
  OR (OLD.accounting_status = 'transport_ambiguous' AND NEW.accounting_status = 'retired_outside_accounting_windows')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid Gemini accounting transition');
END;

CREATE TABLE gemini_row22_recovery_postcondition (
  verified INTEGER NOT NULL
    CONSTRAINT "row 22 recovery postcondition failed" CHECK (verified = 1)
);

INSERT INTO gemini_row22_recovery_postcondition (verified)
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM gemini_usage
  WHERE id = 22
    AND timestamp = '2026-10-12T08:00:10.882Z'
    AND provider = 'gemini'
    AND operation = 'analysis'
    AND request_count = 1
    AND input_tokens = 0
    AND output_tokens = 0
    AND total_tokens = 0
    AND model = 'gemini-3.8-flash'
    AND accounting_status = 'confirmed_zero'
    AND ambiguity_reason IS NULL
    AND settled_at = '2026-10-12T08:00:10.947Z'
    AND retired_at IS NULL
    AND accounting_through = '2026-10-12T08:00:10.947Z'
) THEN 1 ELSE 0 END;

DROP TABLE gemini_row22_recovery_postcondition;
