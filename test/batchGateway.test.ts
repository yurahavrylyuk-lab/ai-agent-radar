import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFile } from "node:fs/promises";
import { createProductionEmailDeliveryDatabase, SqliteD1 } from "./fixtures/emailDeliveryD1.js";

const key = "a".repeat(64);
const endpoint = "https://gateway.example.test/v1/batch";

function pinFixtureClock(t: TestContext, timestamp: string): void {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(timestamp) });
  // SQLite has its own clock for admission, quota windows and delivery leases.
  const prepare = SqliteD1.prototype.prepare;
  t.mock.method(SqliteD1.prototype, "prepare", function (this: SqliteD1, sql: string) {
    return prepare.call(this, sql.replaceAll("'now'", `'${new Date().toISOString()}'`));
  });
}

test("scheduled runs keep their original UTC day and manual recovery requires today's explicit date", async () => {
  const { resolveBatchRun } = await import("../src/githubBatchRunner.js");
  const at = (time: string) => new Date(`2026-11-25T${time}Z`);
  const scheduled = { GITHUB_EVENT_NAME: "schedule", BATCH_CRON: "7 8 * * 3", BATCH_RUN_CREATED_AT: "2026-11-25T08:12:00Z" };
  assert.deepEqual(resolveBatchRun(scheduled, at("10:00:00")), { mode: "primary", date: "2026-11-25" });
  const fallback = { ...scheduled, BATCH_CRON: "17 9 * * 3", BATCH_RUN_CREATED_AT: "2026-11-25T09:30:00Z" };
  assert.deepEqual(resolveBatchRun(fallback, at("10:00:00")), { mode: "fallback", date: "2026-11-25" });
  assert.throws(() => resolveBatchRun(fallback, at("12:00:00")), /schedule_expired/);
  assert.throws(() => resolveBatchRun(scheduled, new Date("2026-11-26T10:00:00Z")), /schedule_expired/);
  assert.throws(() => resolveBatchRun({ ...scheduled, BATCH_RUN_CREATED_AT: "2026-11-26T09:00:00Z" },
    new Date("2026-11-26T10:00:00Z")), /schedule_date_unverified/);
  assert.throws(() => resolveBatchRun({ ...scheduled, BATCH_RUN_CREATED_AT: undefined }, at("10:00:00")), /schedule_date_unverified/);
  assert.throws(() => resolveBatchRun({ ...fallback, BATCH_RUN_CREATED_AT: "2026-11-25T09:00:00Z" }, at("10:00:00")), /schedule_date_unverified/);
  const manual = { GITHUB_EVENT_NAME: "workflow_dispatch", BATCH_LOGICAL_DATE: "2026-11-25" };
  assert.deepEqual(resolveBatchRun(manual, at("14:00:00")), { mode: "recovery", date: "2026-11-25" });
  for (const date of [undefined, "2026-11-24", "2026-11-26", "2026-02-30", "2026-11-25\nsecret"]) {
    assert.throws(() => resolveBatchRun({ ...manual, BATCH_LOGICAL_DATE: date }, at("14:00:00")), /manual_date_invalid/);
  }
});

test("a pre-freeze crash fails subsequent jobs without granting another provider attempt", async (t) => {
  const { handleBatchGateway } = await import("../src/batchGatewayWorker.js");
  const { githubBatchMain } = await import("../src/githubBatchRunner.js");
  const { createBatchGatewayClient } = await import("../src/services/batchGatewayClient.js");
  const { sqlite, d1 } = await createProductionEmailDeliveryDatabase();
  const date = "2026-11-25";
  pinFixtureClock(t, `${date}T10:00:00.000Z`);
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    assert.equal(input.href, endpoint, "held day must not dispatch providers");
    calls.push(JSON.parse(String(init.body)).op);
    return handleBatchGateway(new Request(input, init), { DB: d1 as unknown as D1Database, BATCH_GATEWAY_KEY: key });
  });
  const log = t.mock.method(console, "info", () => {});
  const env = {
    BATCH_RUNNER_ENABLED: "true", BATCH_GATEWAY_URL: endpoint, BATCH_GATEWAY_KEY: key,
    BRAVE_SEARCH_API_KEY: "test-brave", GEMINI_API_KEY: "test-gemini",
    BRAVE_DAILY_SEARCH_LIMIT: "10", BRAVE_WEEKLY_SEARCH_LIMIT: "20", BRAVE_MONTHLY_SEARCH_LIMIT: "30",
    RESEND_API_KEY: "test-resend", NOTIFICATION_EMAIL: "owner@example.test",
  };
  try {
    assert.equal(await createBatchGatewayClient(endpoint, key).acquireDay(date, "admit"), true);
    sqlite.prepare("UPDATE controlled_execution_locks SET created_at='2020-01-01T00:00:00.000Z'").run();
    calls.length = 0;
    const weekday = new Date().getUTCDay();
    assert.equal(await githubBatchMain({ ...env, GITHUB_EVENT_NAME: "schedule", BATCH_CRON: `7 8 * * ${weekday}`,
      BATCH_RUN_CREATED_AT: `${date}T08:07:00Z` }), 1);
    assert.deepEqual(calls, ["daily.admit", "ledger.read"]);
    calls.length = 0;
    assert.equal(await githubBatchMain({ ...env, GITHUB_EVENT_NAME: "schedule", BATCH_CRON: `17 9 * * ${weekday}`,
      BATCH_RUN_CREATED_AT: `${date}T09:17:00Z` }), 1);
    assert.deepEqual(calls, ["daily.admit", "daily.recover", "ledger.read"]);
    calls.length = 0;
    assert.equal(await githubBatchMain({ ...env, GITHUB_EVENT_NAME: "workflow_dispatch", BATCH_LOGICAL_DATE: date }), 1);
    assert.deepEqual(calls, ["daily.recover", "ledger.read"]);
    for (const call of log.mock.calls) {
      assert.deepEqual(JSON.parse(String(call.arguments[0])), {
        event: "github_batch_result", date, action: "held", accepted: false, reason: "no_frozen_payload",
      });
    }
    assert.equal(log.mock.callCount(), 3);
    assert.equal(sqlite.prepare("SELECT count(*) count FROM controlled_execution_locks").get()!.count, 1);
    assert.equal(sqlite.prepare("SELECT count(*) count FROM email_deliveries").get()!.count, 0);
  } finally { sqlite.close(); }
});

test("only authenticated allowlisted calls can acquire one durable daily admission", async () => {
  const { handleBatchGateway } = await import("../src/batchGatewayWorker.js");
  const { sqlite, d1 } = await createProductionEmailDeliveryDatabase();
  try {
    const date = new Date().toISOString().slice(0, 10);
    const send = (op: string, args: unknown[], authorization?: string) => handleBatchGateway(
      new Request(endpoint, { method: "POST", body: JSON.stringify({ op, args }),
        headers: authorization ? { authorization } : {} }),
      { DB: d1 as unknown as D1Database, BATCH_GATEWAY_KEY: key },
    );
    assert.equal((await send("daily.admit", [date])).status, 401);
    assert.equal((await send("daily.admit", [date], "Bearer " + "b".repeat(64))).status, 401);
    assert.equal((await send("prepare", ["SELECT 1"], "Bearer " + key)).status, 400);
    assert.equal((await send("daily.admit", ["not-a-date"], "Bearer " + key)).status, 400);
    assert.equal((await send("daily.admit", [date, "x".repeat(460_000)], "Bearer " + key)).status, 413);
    const replies = await Promise.all(Array.from({ length: 8 }, () => send("daily.admit", [date], "Bearer " + key)));
    assert.ok(replies.every(reply => reply.ok));
    const results = await Promise.all(replies.map(reply => reply.json()));
    assert.equal(results.filter(result => result.value === true).length, 1);
    assert.equal(sqlite.prepare("SELECT count(*) count FROM controlled_execution_locks").get()!.count, 1);
    assert.equal((await (await send("daily.recover", [date], "Bearer " + key)).json()).value, false);
  } finally { sqlite.close(); }
});

for (const feedbackEnabled of [false, true]) {
  test(`Node runner completes and recovers one frozen digest ${feedbackEnabled ? "with feedback" : "without feedback"}`,
    t => verifyBatchDigest(t, feedbackEnabled));
}

async function verifyBatchDigest(t: TestContext, feedbackEnabled: boolean) {
  const startedAt = "2026-11-25T08:01:00.000Z";
  pinFixtureClock(t, startedAt);
  const { handleBatchGateway } = await import("../src/batchGatewayWorker.js");
  const { runGitHubBatch } = await import("../src/githubBatchRunner.js");
  const { createBatchGatewayClient } = await import("../src/services/batchGatewayClient.js");
  const { RSS_FEEDS } = await import("../src/config/rssSources.js");
  const { sqlite, d1 } = await createProductionEmailDeliveryDatabase();
  if (feedbackEnabled) sqlite.exec(await readFile(new URL("../migrations/0011_email_feedback.sql", import.meta.url), "utf8"));
  const origin = "https://feedback.example";
  const keyring = { active: { id: "test", secret: "c".repeat(32) } };
  const selection = {
    candidateId: "c001", relevanceScore: 8, category: "developer_tool", name: "Gemini model fixture",
    summary: "Synthetic story", whyItMatters: "Fixture", educationalValue: "Fixture",
    technologies: [], projectOpportunities: [],
  };
  const knownUrl = "https://example.test/news/10";
  const firstSeenAt = "2026-11-20T08:00:00.000Z";
  sqlite.prepare("INSERT INTO discoveries VALUES (?, ?, ?, ?)").run(
    knownUrl, firstSeenAt, firstSeenAt, JSON.stringify({ ...selection, sourceTitle: "Known story", sourceUrl: knownUrl }),
  );
  const counts = { brave: 0, rss: 0, gemini: 0, resend: 0 };
  const rssEndpoints = new Set<string>();
  const accepted = new Map<string, string>();
  const responses = new Set<string>();
  const prompts: string[] = [];
  const gatewayOperations: string[] = [];
  let loseSendResponse = true;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    switch (url.hostname) {
      case "api.search.brave.com": {
        counts.brave++;
        return Response.json({ web: { results: [
          { title: "Synthetic Brave " + counts.brave, url: "https://example.test/news/" + counts.brave, description: "Synthetic story" },
        ] } });
      }
      case "generativelanguage.googleapis.com":
        counts.gemini++;
        prompts.push(String(init?.body));
        assert.match(String(init?.body), /github\.blog/);
        assert.ok(!String(init?.body).includes(knownUrl), "known discovery must be excluded from analysis");
        return Response.json({ output_text: JSON.stringify({ schemaVersion: 1, stories: [selection] }),
          usage: { total_input_tokens: 40, total_output_tokens: 20, total_tokens: 60 } });
      case "api.resend.com": {
        counts.resend++;
        const idempotency = new Headers(init?.headers).get("idempotency-key");
        assert.ok(idempotency?.startsWith("daily-digest/"));
        const body = String(init?.body);
        responses.add(body);
        if (accepted.has(idempotency!)) assert.equal(accepted.get(idempotency!), body);
        else accepted.set(idempotency!, body);
        if (loseSendResponse) { loseSendResponse = false; throw new Error("synthetic lost response"); }
        return Response.json({ id: "synthetic-acceptance" });
      }
      default: {
        const feed = RSS_FEEDS.find(feed => feed.endpoint === url.href);
        assert.ok(feed, "only fixture URLs may be used");
        counts.rss++;
        rssEndpoints.add(url.href);
        return new Response(`<rss version="2.0"><channel><item><title>Synthetic RSS</title><link>https://${feed.articleHostnames[0]}/synthetic</link><pubDate>${new Date(Date.now() - 86400000).toUTCString()}</pubDate><description>Fixture</description></item></channel></rss>`,
          { headers: { "content-type": "application/rss+xml" } });
      }
    }
  });
  const env = {
    BRAVE_SEARCH_API_KEY: "test-brave", BRAVE_DAILY_SEARCH_LIMIT: "10", BRAVE_WEEKLY_SEARCH_LIMIT: "20", BRAVE_MONTHLY_SEARCH_LIMIT: "30",
    GEMINI_API_KEY: "test-gemini", GEMINI_DAILY_REQUEST_LIMIT: "1", GEMINI_WEEKLY_REQUEST_LIMIT: "10", GEMINI_MONTHLY_REQUEST_LIMIT: "20",
    GEMINI_DAILY_TOKEN_LIMIT: "10000", GEMINI_WEEKLY_TOKEN_LIMIT: "20000", GEMINI_MONTHLY_TOKEN_LIMIT: "30000",
    RESEND_API_KEY: "test-resend", NOTIFICATION_EMAIL: "owner@example.test",
    ...(feedbackEnabled ? { FEEDBACK_ORIGIN: origin, FEEDBACK_SIGNING_KEY_ID: keyring.active.id, FEEDBACK_SIGNING_KEY: keyring.active.secret } : {}),
  };
  const createClient = () => createBatchGatewayClient(endpoint, key, (async (input, init) => {
    gatewayOperations.push(JSON.parse(String(init?.body)).op);
    return handleBatchGateway(new Request(input, init), { DB: d1 as unknown as D1Database, BATCH_GATEWAY_KEY: key });
  }) as typeof fetch);
  const date = startedAt.slice(0, 10);
  try {
    const runs = await Promise.all([1, 2].map(() => runGitHubBatch({ mode: "primary", date, env, gateway: createClient() })));
    assert.deepEqual(runs.map(run => run.action).sort(), ["cycle", "held"]);
    assert.equal(sqlite.prepare("SELECT mode FROM email_deliveries").get()!.mode, "normal");
    assert.deepEqual(counts, { brave: 10, rss: 4, gemini: 1, resend: 1 });
    assert.deepEqual(rssEndpoints, new Set(RSS_FEEDS.map(feed => feed.endpoint)));
    assert.equal(accepted.size, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM brave_usage").get()!.count, 10);
    assert.equal(sqlite.prepare("SELECT state FROM email_deliveries").get()!.state, "ambiguous");
    const accounting = sqlite.prepare(`SELECT u.accounting_status, u.request_count, u.input_tokens,
      u.output_tokens, u.total_tokens, a.dispatch_status, a.settlement_status
      FROM monitoring_gemini_attempts a JOIN gemini_usage u ON a.usage_id = u.id`).all();
    assert.deepEqual(accounting, [{ accounting_status: "exact", request_count: 1, input_tokens: 40,
      output_tokens: 20, total_tokens: 60, dispatch_status: "observed", settlement_status: "settled" }]);
    assert.deepEqual(sqlite.prepare("SELECT scheduled_at, started_at, phase FROM monitoring_cycles").all(), [
      { scheduled_at: `${date}T08:00:00.000Z`, started_at: startedAt, phase: "completed" },
    ]);
    assert.equal(sqlite.prepare("SELECT last_seen_at FROM discoveries WHERE normalized_url=?").get(knownUrl)!.last_seen_at, startedAt);
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM discoveries WHERE first_seen_at=?").get(startedAt)!.count, 1);

    // Move only the fixture's clock evidence past the workflow timeout and ledger lease.
    sqlite.prepare("UPDATE controlled_execution_locks SET created_at='2020-01-01T00:00:00.000Z'").run();
    sqlite.prepare("UPDATE email_deliveries SET lease_until=NULL,claim_token=NULL").run();
    const recovery = await runGitHubBatch({ mode: "recovery", date, env, gateway: createClient() });
    assert.deepEqual(recovery, { action: "recovery", accepted: true });
    assert.equal((await runGitHubBatch({ mode: "fallback", date, env, gateway: createClient() })).action, "held");
    assert.deepEqual(counts, { brave: 10, rss: 4, gemini: 1, resend: 2 });
    assert.equal(responses.size, 1);
    assert.equal(accepted.size, 1);
    assert.equal(sqlite.prepare("SELECT state FROM email_deliveries").get()!.state, "accepted");
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM notifications").get()!.count, 1);
    const digest = JSON.parse([...accepted.values()][0]);
    assert.equal(digest.subject, "AI Agent Radar — Daily Digest");
    assert.match(digest.text, /Relevance: 8\/10/);
    assert.doesNotMatch(prompts[0]!, /feedbackPreferences/);
    const { searchWebPage } = await import("../src/tools/webSearch.js");
    const { braveUsageStore } = createClient().persistence;
    await assert.rejects(searchWebPage("short quota probe", { environment: env, usageTracker: braveUsageStore }),
      { name: "BraveUsageGuardDeniedError" });
    assert.equal(counts.brave, 10);

    const feedbackOps = () => gatewayOperations.filter(op => op.startsWith("feedback.") || op === "ledger.reserveWithBindings");
    if (!feedbackEnabled) {
      assert.doesNotMatch(digest.text, /feedback\?token=/);
      assert.deepEqual(feedbackOps(), []);
      return;
    }
    assert.deepEqual(feedbackOps(), ["feedback.pruneExpired", "feedback.getPreferenceProfile", "ledger.reserveWithBindings"]);
    const { handleEmailFeedbackRoute } = await import("../src/services/emailFeedbackRoutes.js");
    const relevant = digest.text.match(/^Relevant: (\S+)$/m)?.[1];
    const negative = digest.text.match(/^Not Relevant: (\S+)$/m)?.[1];
    assert.ok(relevant && negative && relevant !== negative);
    const route = (request: Request) => handleEmailFeedbackRoute(request, d1 as unknown as D1Database, {origin, keyring});
    const submit = async (url: string, rating: string, revision: number) => {
      const result = await route(new Request(url));
      assert.equal(result?.status, 200);
      assert.equal(sqlite.prepare("SELECT count(*) count FROM email_feedback_votes").get()!.count, revision === 0 ? 0 : 1);
      const nonce = (await result!.text()).match(/name="nonce" value="([^"]+)"/)?.[1];
      assert.ok(nonce);
      const body = new URLSearchParams({ token: new URL(url).searchParams.get("token")!, nonce, rating, revision: String(revision) });
      const post = (requestOrigin: string) => route(new Request(origin + "/feedback/confirm", {
        method: "POST", headers: { origin: requestOrigin }, body,
      }));
      assert.equal((await post("https://other.example"))?.status, 400);
      assert.equal((await post(origin))?.status, 200);
    };
    await submit(relevant, "relevant", 0);
    await submit(negative, "not_relevant", 1);
    assert.deepEqual(sqlite.prepare("SELECT rating,revision FROM email_feedback_votes").all(), [{rating:"not_relevant", revision:2}]);
    const tampered = new URL(relevant);
    tampered.searchParams.set("token", "x" + tampered.searchParams.get("token")!);
    assert.equal((await route(new Request(tampered)))?.status,400);
    assert.equal((await handleEmailFeedbackRoute(new Request(relevant),d1 as unknown as D1Database,{origin,keyring},
      new Date("2027-01-01T08:00:00Z")))?.status,410);
    assert.equal(sqlite.prepare("SELECT revision FROM email_feedback_votes").get()!.revision,2);

    // Add four distinct historical votes to cross the existing five-story evidence threshold.
    const older = "daily-digest/2026-11-23";
    const olderAt = "2026-11-23T08:00:00.000Z";
    sqlite.prepare(`INSERT INTO email_deliveries
      (delivery_key,logical_date,state,payload_sha256,created_at,updated_at,provider_message_id,accepted_at,reconciled_at,last_reason)
      VALUES (?,'2026-11-23','accepted',?,?,?,'historical-fixture',?,?,'history_reconciled')`)
      .run(older, "1".repeat(64), olderAt, olderAt, olderAt, olderAt);
    for (let slot = 1; slot <= 4; slot++) {
      const hash = String(slot + 1).repeat(64);
      sqlite.prepare(`INSERT INTO email_feedback_stories
        (delivery_key,slot,payload_sha256,story_sha256,discovery_key,display_title,kind,topic_version,topics_json,issued_at,expires_at,key_id,relevant_digest,not_relevant_digest)
        VALUES (?,?,?,?,?,'Gemini history','analyzed',1,'["ai_ml"]',?,'2026-12-23T08:00:00.000Z','test',?,?)`)
        .run(older, slot, "1".repeat(64), hash, hash, olderAt, "d".repeat(64), "e".repeat(64));
      sqlite.prepare(`INSERT INTO email_feedback_votes VALUES (?,?,'not_relevant',1,?,?,?)`)
        .run(older, slot, "e".repeat(64), olderAt, olderAt);
    }
    const nextDate = "2026-11-26";
    t.mock.timers.setTime(Date.parse(`${nextDate}T08:01:00Z`));
    assert.deepEqual(await runGitHubBatch({ mode: "primary", date: nextDate, env, gateway: createClient() }),
      { action:"cycle", accepted:true });
    assert.match(prompts[1]!, /feedbackPreferences/);
    assert.match(prompts[1]!, /deprioritize.*AI and machine learning/);
    assert.deepEqual(counts, { brave:20, rss:8, gemini:2, resend:3 });
    assert.equal(accepted.size, 2);
    assert.deepEqual(feedbackOps(), ["feedback.pruneExpired", "feedback.getPreferenceProfile", "ledger.reserveWithBindings",
      "feedback.pruneExpired", "feedback.getPreferenceProfile", "ledger.reserveWithBindings"]);
  } finally { sqlite.close(); }
}

test("an admission response lost after commit cannot grant a second run", async () => {
  const { handleBatchGateway } = await import("../src/batchGatewayWorker.js");
  const { createBatchGatewayClient } = await import("../src/services/batchGatewayClient.js");
  const { sqlite, d1 } = await createProductionEmailDeliveryDatabase();
  try {
    let lose = true;
    const gateway = createBatchGatewayClient(endpoint, key, (async (input, init) => {
      const response = await handleBatchGateway(new Request(input, init), { DB: d1 as unknown as D1Database, BATCH_GATEWAY_KEY: key });
      if (lose) { lose = false; throw new Error("synthetic lost authorization"); }
      return response;
    }) as typeof fetch);
    const day = new Date().toISOString().slice(0, 10);
    await assert.rejects(gateway.acquireDay(day, "admit"), /could not be confirmed/);
    assert.equal(await gateway.acquireDay(day, "admit"), false);
    assert.equal(sqlite.prepare("SELECT count(*) count FROM controlled_execution_locks").get()!.count, 1);
  } finally { sqlite.close(); }
});

test("gateway keeps Gemini usage and attempt settlement in the same transaction", async () => {
  const { handleBatchGateway } = await import("../src/batchGatewayWorker.js");
  const { createBatchGatewayClient } = await import("../src/services/batchGatewayClient.js");
  const { sqlite, d1 } = await createProductionEmailDeliveryDatabase();
  try {
    const gateway = createBatchGatewayClient(endpoint, key, (async (input, init) =>
      handleBatchGateway(new Request(input, init), { DB: d1 as unknown as D1Database, BATCH_GATEWAY_KEY: key })) as typeof fetch);
    const timestamp = new Date().toISOString();
    const cycleId = crypto.randomUUID();
    await gateway.telemetry.createCycle({ cycleId, startedAt: timestamp, scheduledAt: timestamp, sourceSha: null, workerVersion: null });
    const store = gateway.persistence.geminiUsageStore;
    const record = { timestamp, provider: "gemini", operation: "analysis", requestCount: 1,
      model: "gemini-3.8-flash", inputTokens: 0, outputTokens: 0, totalTokens: 0 } as const;
    const admission = { cycleRequestsRemaining: 1, limits: { dailyRequests: 1, weeklyRequests: 10, monthlyRequests: 20,
      dailyTokens: 100, weeklyTokens: 200, monthlyTokens: 300 } };
    const reserved = await store.reserveRequest(record, admission);
    const ref = { cycleId, ordinal: 1 } as const;
    await gateway.telemetry.bindAttempt(ref, reserved);
    await gateway.telemetry.markDispatchIntent(ref);
    await gateway.telemetry.markDispatchObserved(ref);
    const exact = { kind: "exact", usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      evidence: { failureClass: "none", httpStatus: 200, accountingError: false, observedAt: new Date().toISOString() } } as const;
    sqlite.exec("CREATE TRIGGER fault_gemini BEFORE UPDATE OF settlement_status ON monitoring_gemini_attempts BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END");
    await assert.rejects(store.settleObservedAttempt(ref, reserved, exact), /could not be confirmed/);
    assert.equal(sqlite.prepare("SELECT accounting_status FROM gemini_usage WHERE id=?").get(reserved.record.id)!.accounting_status, "reserved");
    assert.equal(sqlite.prepare("SELECT settlement_status FROM monitoring_gemini_attempts WHERE cycle_id=?").get(cycleId)!.settlement_status, "pending");
    sqlite.exec("DROP TRIGGER fault_gemini");
    await store.settleObservedAttempt(ref, reserved, exact);
    await store.settleObservedAttempt(ref, reserved, exact);
    assert.equal((await gateway.telemetry.readCycle(cycleId))?.attempts[0].settlementStatus, "settled");
    await assert.rejects(store.reserveRequest(record, admission), /could not be confirmed/);
    assert.equal(sqlite.prepare("SELECT count(*) count FROM gemini_usage WHERE accounting_status='exact'").get()!.count, 1);
  } finally { sqlite.close(); }
});
