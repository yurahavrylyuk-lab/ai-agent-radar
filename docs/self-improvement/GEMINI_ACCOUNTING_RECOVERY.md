# Gemini ambiguity accounting recovery

This runbook documents operator actions; it is not deployment or recovery authorization. Never run these procedures from a monitoring invocation. Migration, Worker deployment, structured retirement, and the legacy row-17 latch clear each require separate human approval.

## Accounting meaning

- `exact` contains provider-reported usage. `total_tokens` remains authoritative and may include thinking tokens.
- `confirmed_zero` is used only for reviewed non-2xx responses whose existing retry/fallback contract establishes zero usage.
- `reserved` and `transport_ambiguous` are unresolved. Their numeric `0/0/0` values are placeholders, not evidence of zero usage.
- `retired_outside_accounting_windows` preserves the unknown placeholders forever. Retirement means only that the request timestamp is outside the current UTC day, Monday-start UTC week, and calendar month.
- No recovery invents, estimates, or derives a token count.

## Future structured ambiguity

Use the provider-free `retireStructuredGeminiAmbiguity()` service only from a trusted, human-operated D1 adapter context. Supply the exact row ID, immutable timestamp, exact approved model, ambiguity reason, trusted current time, and affirmative evidence that the original invocation terminated and cannot dispatch. The service rereads authoritative state and refuses missing termination evidence, mismatches, legacy-latch uncertainty, and active accounting windows. The D1 compare-and-set repeats identity, zero-placeholder, status, legacy-latch, and database-UTC window checks atomically. A safe rerun recognizes the exact retired state. An uncertain result requires an authoritative reread; never retry blindly.

Retirement does not call Gemini, start monitoring, or clear `gemini_usage_state.usage_unknown`.

## Legacy incident row 17

The incident is permanently described as historical unknown usage:

- Database ID: `9fb545e2-2f43-4922-8b21-2d79a8de9556`
- Row ID: `17`
- Timestamp: `2026-10-08T08:02:03.393Z`
- Operation/model/request count: `analysis` / `gemini-3.8-flash` / `1`
- Unresolved placeholders: `0/0/0`
- Earliest safe boundary: `2026-11-01T00:00:00Z`

Before any separately authorized recovery, the operator must verify the configured production D1 identity, preserve an accounting-only before snapshot, prove the old scheduled invocation cannot dispatch, verify migration/schema state, verify the singleton latch is `1`, and verify the exact row above. Because Gemini has remained blocked, any row with `id > 17` is unexpected and blocks this incident-specific procedure. Any structured `reserved` or `transport_ambiguous` row also blocks it.

The reviewed conditional mutation changes only the singleton latch. It must be executed only after replacing `<DATABASE_NAME_OR_UUID_ALREADY_VERIFIED_BY_OPERATOR>` with the already verified production target and receiving separate approval:

```sql
UPDATE gemini_usage_state
SET usage_unknown = 0
WHERE id = 1
  AND usage_unknown = 1
  AND strftime('%Y-%m-%dT%H:%M:%fZ', 'now') >= '2026-11-01T00:00:00.000Z'
  AND EXISTS (
    SELECT 1 FROM gemini_usage
    WHERE id = 17
      AND timestamp = '2026-10-08T08:02:03.393Z'
      AND provider = 'gemini'
      AND operation = 'analysis'
      AND request_count = 1
      AND input_tokens = 0
      AND output_tokens = 0
      AND total_tokens = 0
      AND model = 'gemini-3.8-flash'
      AND accounting_status = 'legacy'
      AND ambiguity_reason IS NULL
      AND settled_at IS NULL
      AND retired_at IS NULL
  )
  AND NOT EXISTS (SELECT 1 FROM gemini_usage WHERE id > 17)
  AND NOT EXISTS (
    SELECT 1 FROM gemini_usage
    WHERE accounting_status IN ('reserved', 'transport_ambiguous')
  )
RETURNING id, usage_unknown;
```

Exactly one returned row `(1, 0)` is required. A zero-row result is refusal, not success. A lost response requires a read before any retry. Do not change row 17.

Post-recovery verification must select the singleton state and row 17 again, confirm the database UTC time, confirm no row above 17, and compare the before/after accounting snapshot. The only difference may be `gemini_usage_state.usage_unknown: 1 -> 0`; row 17 and every usage field remain byte-for-byte unchanged. Archive the approval and evidence without secrets, prompts, or source content. Do not launch a catch-up cycle.
