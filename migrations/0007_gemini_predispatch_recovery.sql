DROP TRIGGER gemini_usage_validate_accounting_transition;

CREATE TRIGGER gemini_usage_validate_accounting_transition
BEFORE UPDATE ON gemini_usage
WHEN NOT (
  (OLD.accounting_status = 'reserved' AND NEW.accounting_status IN ('exact', 'confirmed_zero', 'transport_ambiguous'))
  OR (OLD.accounting_status = 'transport_ambiguous' AND NEW.accounting_status = 'retired_outside_accounting_windows')
  OR (
    OLD.accounting_status = 'transport_ambiguous'
    AND OLD.ambiguity_reason = 'abandoned_reservation'
    AND NEW.accounting_status = 'confirmed_zero'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid Gemini accounting transition');
END;
