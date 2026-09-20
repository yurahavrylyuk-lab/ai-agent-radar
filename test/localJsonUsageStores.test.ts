import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalJsonBraveUsageStore } from "../src/services/localJsonBraveUsageStore.js";
import { LocalJsonGeminiUsageStore } from "../src/services/localJsonGeminiUsageStore.js";

async function withTemporaryFile(
  name: string,
  callback: (filePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ai-agent-radar-"));
  try {
    await callback(join(directory, name));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("local Brave JSON store initializes missing state and preserves recorded request data", async () => {
  await withTemporaryFile("brave-usage.json", async (filePath) => {
    const store = new LocalJsonBraveUsageStore(filePath);
    assert.deepEqual(await store.getRecords(), []);

    await store.recordRequest({
      timestamp: "2026-09-20T10:00:00.000Z",
      provider: "brave",
      operation: "web-search",
      requestCount: 1,
    });

    assert.deepEqual(await store.getRecords(), [{
      timestamp: "2026-09-20T10:00:00.000Z",
      provider: "brave",
      operation: "web-search",
      requestCount: 1,
    }]);
  });
});

test("corrupted Brave JSON state is rejected without being overwritten", async () => {
  await withTemporaryFile("brave-usage.json", async (filePath) => {
    await writeFile(filePath, "{not-json", "utf8");
    const store = new LocalJsonBraveUsageStore(filePath);

    await assert.rejects(store.getRecords());
    assert.equal(await readFile(filePath, "utf8"), "{not-json");
  });
});

test("local Gemini JSON store preserves thinking-inclusive total-token records", async () => {
  await withTemporaryFile("gemini-usage.json", async (filePath) => {
    const store = new LocalJsonGeminiUsageStore(filePath);
    assert.deepEqual(await store.getUsageData(), { records: [], usageUnknown: false });

    await store.recordRequest({
      timestamp: "2026-09-20T10:00:00.000Z",
      provider: "gemini",
      operation: "generate",
      requestCount: 1,
      inputTokens: 9,
      outputTokens: 4,
      totalTokens: 112,
    });

    assert.deepEqual(await store.getUsageData(), {
      usageUnknown: false,
      records: [{
        timestamp: "2026-09-20T10:00:00.000Z",
        provider: "gemini",
        operation: "generate",
        requestCount: 1,
        inputTokens: 9,
        outputTokens: 4,
        totalTokens: 112,
      }],
    });
  });
});

test("corrupted Gemini JSON state fails closed without being overwritten", async () => {
  await withTemporaryFile("gemini-usage.json", async (filePath) => {
    await writeFile(filePath, JSON.stringify({ records: [], usageUnknown: "unknown" }), "utf8");
    const store = new LocalJsonGeminiUsageStore(filePath);

    await assert.rejects(store.getUsageData());
    assert.equal(
      await readFile(filePath, "utf8"),
      JSON.stringify({ records: [], usageUnknown: "unknown" }),
    );
  });
});

test("local usage stores retain pre-existing runtime records when writing", async () => {
  await withTemporaryFile("brave-usage.json", async (bravePath) => {
    await writeFile(bravePath, JSON.stringify({ records: [{
      timestamp: "2026-09-19T10:00:00.000Z",
      provider: "brave",
      operation: "web-search",
      requestCount: 1,
    }] }), "utf8");
    const braveStore = new LocalJsonBraveUsageStore(bravePath);
    await braveStore.recordRequest({
      timestamp: "2026-09-20T10:00:00.000Z",
      provider: "brave",
      operation: "web-search",
      requestCount: 1,
    });
    assert.equal((await braveStore.getRecords()).length, 2);
  });

  await withTemporaryFile("gemini-usage.json", async (geminiPath) => {
    await writeFile(geminiPath, JSON.stringify({ usageUnknown: false, records: [{
      timestamp: "2026-09-19T10:00:00.000Z",
      provider: "gemini",
      operation: "generate",
      requestCount: 1,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 3,
    }] }), "utf8");
    const geminiStore = new LocalJsonGeminiUsageStore(geminiPath);
    await geminiStore.markUsageUnknown();
    const data = await geminiStore.getUsageData();
    assert.equal(data.records.length, 1);
    assert.equal(data.usageUnknown, true);
  });
});
