import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type WranglerConfiguration = {
  name?: unknown;
  main?: unknown;
  observability?: {
    redact_query_string?: unknown;
    logs?: Record<string, unknown>;
    traces?: Record<string, unknown>;
  };
  triggers?: unknown;
  d1_databases?: unknown;
  vars?: unknown;
  secrets?: unknown;
};

test("release configuration explicitly redacts query strings without weakening scheduled observability", () => {
  const configuration = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as WranglerConfiguration;
  assert.equal(configuration.observability?.redact_query_string, true);
  assert.deepEqual(configuration.observability?.logs, {
    enabled: true,
    head_sampling_rate: 1,
    persist: true,
  });
  assert.deepEqual(configuration.observability?.traces, { enabled: false });
  assert.deepEqual(configuration.triggers, { crons: ["0 8 * * *"] });

  const schema = JSON.parse(readFileSync(new URL("../node_modules/wrangler/config-schema.json", import.meta.url), "utf8")) as {
    definitions?: { Observability?: { properties?: Record<string, { type?: unknown }> } };
  };
  assert.equal(schema.definitions?.Observability?.properties?.redact_query_string?.type, "boolean");
});
