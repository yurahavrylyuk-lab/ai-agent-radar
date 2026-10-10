DROP INDEX gemini_usage_one_unresolved_request;

CREATE UNIQUE INDEX gemini_usage_one_unresolved_request
  ON gemini_usage ((1))
  WHERE accounting_status = 'reserved'
    OR (
      accounting_status = 'transport_ambiguous'
      AND (ambiguity_reason IS NULL OR ambiguity_reason <> 'timeout')
    );
