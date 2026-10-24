import { OPENAI_FALLBACK, type OpenAIFallbackLimits } from "../config/openaiFallback.js";

export interface OpenAIExactUsage { inputTokens: number; outputTokens: number; totalTokens: number; }
export interface LunaReservation { cycleId: string; scheduledAt: string; reservedAt: string; attemptId: string; }
export type LunaFailureClass = "none" | "not_admitted" | "timeout" | "transport_error" | "http_failure" | "invalid_response" | "usage_unknown" | "accounting_failure";
export interface LunaEvidence { outcome: LunaFailureClass; httpStatus: number | null; endedAt: string; durationMs: number; }
export interface OpenAIFallbackUsageRecord extends LunaReservation {
  accountingThrough: string; startedAt: string | null; settledAt: string | null; requestCount: 1;
  state: "reserved" | "exact" | "unknown" | "cancelled_pre_dispatch";
  dispatchStatus: "not_dispatched" | "intent" | "observed";
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  failureClass: LunaFailureClass; httpStatus: number | null; durationMs: number | null; budgetAnomaly: boolean;
}

interface Row { cycle_id:string; attempt_id:string; scheduled_at:string; reserved_at:string; accounting_through:string; started_at:string|null; settled_at:string|null; request_count:number; state:OpenAIFallbackUsageRecord["state"]; dispatch_status:OpenAIFallbackUsageRecord["dispatchStatus"]; input_tokens:number|null; output_tokens:number|null; total_tokens:number|null; failure_class:LunaFailureClass; http_status:number|null; duration_ms:number|null; budget_anomaly:number; }
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const failures: LunaFailureClass[] = ["none","not_admitted","timeout","transport_error","http_failure","invalid_response","usage_unknown","accounting_failure"];
const safe = (value:number) => Number.isSafeInteger(value) && value >= 0;

function parseRow(row: Row | null): OpenAIFallbackUsageRecord | null {
  if (!row) return null;
  if (!uuid.test(row.cycle_id) || !uuid.test(row.attempt_id) || !iso.test(row.scheduled_at) || !iso.test(row.reserved_at) || !iso.test(row.accounting_through) ||
    row.accounting_through < row.reserved_at || (row.started_at !== null && (!iso.test(row.started_at) || row.started_at < row.reserved_at)) ||
    (row.settled_at !== null && (!iso.test(row.settled_at) || row.settled_at < row.reserved_at)) || row.request_count !== 1 ||
    !["reserved","exact","unknown","cancelled_pre_dispatch"].includes(row.state) || !["not_dispatched","intent","observed"].includes(row.dispatch_status) ||
    !failures.includes(row.failure_class) || ![0,1].includes(row.budget_anomaly)) throw new Error("OpenAI fallback accounting row is invalid.");
  for (const value of [row.input_tokens,row.output_tokens,row.total_tokens]) if (value !== null && !safe(value)) throw new Error("OpenAI fallback accounting row is invalid.");
  if (row.state === "exact" && (row.input_tokens === null || row.output_tokens === null || row.total_tokens !== row.input_tokens + row.output_tokens)) throw new Error("OpenAI fallback accounting row is invalid.");
  if (row.state !== "exact" && [row.input_tokens,row.output_tokens,row.total_tokens].some(value => value !== null)) throw new Error("OpenAI fallback accounting row is invalid.");
  return { cycleId:row.cycle_id, attemptId:row.attempt_id, scheduledAt:row.scheduled_at, reservedAt:row.reserved_at,
    accountingThrough:row.accounting_through, startedAt:row.started_at, settledAt:row.settled_at, requestCount:1, state:row.state,
    dispatchStatus:row.dispatch_status, inputTokens:row.input_tokens, outputTokens:row.output_tokens, totalTokens:row.total_tokens,
    failureClass:row.failure_class, httpStatus:row.http_status, durationMs:row.duration_ms, budgetAnomaly:row.budget_anomaly===1 };
}

function validateLimits(limits: OpenAIFallbackLimits) {
  return Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0) &&
    limits.dailyRequests <= 1 && limits.weeklyRequests <= 7 && limits.monthlyRequests <= 31 &&
    limits.dailyTokens <= 24_576 && limits.weeklyTokens <= 172_032 && limits.monthlyTokens <= 761_856;
}
function validateRef(ref:LunaReservation) { return uuid.test(ref.cycleId) && uuid.test(ref.attemptId) && iso.test(ref.scheduledAt) && iso.test(ref.reservedAt); }
function validateEvidence(e:LunaEvidence) { return failures.includes(e.outcome) && (e.httpStatus===null||(Number.isInteger(e.httpStatus)&&e.httpStatus>=100&&e.httpStatus<=599)) && iso.test(e.endedAt) && Number.isInteger(e.durationMs)&&e.durationMs>=0&&e.durationMs<=110_000; }

const proof = `
  (SELECT count(*) FROM monitoring_gemini_attempts a JOIN gemini_usage g ON g.id=a.usage_id
    WHERE a.cycle_id=?1 AND a.ordinal BETWEEN 1 AND 3 AND a.failure_class='unavailable_503' AND a.http_status=503
      AND a.accounting_status='confirmed_zero' AND a.accounting_error=0 AND a.settlement_status='settled'
      AND a.dispatch_status='observed' AND g.id=a.usage_id AND g.model=a.model AND g.timestamp=a.started_at
      AND g.accounting_status='confirmed_zero' AND g.request_count=1)=3
  AND EXISTS(SELECT 1 FROM monitoring_gemini_attempts WHERE cycle_id=?1 AND ordinal=3 AND retry_decision='stop' AND retry_reason='max_attempts')
  AND EXISTS(SELECT 1 FROM gemini_usage_state WHERE id=1 AND usage_unknown=0)
  AND NOT EXISTS(SELECT 1 FROM gemini_usage WHERE accounting_status IN ('reserved','transport_ambiguous'))`;

export class D1OpenAIFallbackUsageStore {
  constructor(private readonly database:D1Database) {}
  async read(cycleId:string) {
    if (!uuid.test(cycleId)) return null;
    return parseRow(await this.database.prepare("SELECT cycle_id,attempt_id,scheduled_at,reserved_at,accounting_through,started_at,settled_at,request_count,state,dispatch_status,input_tokens,output_tokens,total_tokens,failure_class,http_status,duration_ms,budget_anomaly FROM openai_fallback_usage WHERE cycle_id=?1").bind(cycleId).first<Row>());
  }
  async reserve(cycleId:string, limits:OpenAIFallbackLimits):Promise<LunaReservation|null> {
    if (!uuid.test(cycleId) || !validateLimits(limits)) return null;
    const attemptId=crypto.randomUUID();
    const now="strftime('%Y-%m-%dT%H:%M:%fZ','now')", day="strftime('%Y-%m-%dT00:00:00.000Z','now')", week="strftime('%Y-%m-%dT00:00:00.000Z','now','-'||((CAST(strftime('%w','now') AS INTEGER)+6)%7)||' days')", month="strftime('%Y-%m-01T00:00:00.000Z','now')";
    const sql=`INSERT INTO openai_fallback_usage(cycle_id,attempt_id,scheduled_at,model,reserved_at,accounting_through,request_count,reserved_input,reserved_output,reserved_total,state,dispatch_status,failure_class)
      SELECT c.cycle_id,?2,c.scheduled_at,'${OPENAI_FALLBACK.model}',${now},${now},1,12288,12288,24576,'reserved','not_dispatched','none' FROM monitoring_cycles c
      WHERE c.cycle_id=?1 AND ${proof}
      AND NOT EXISTS(SELECT 1 FROM openai_fallback_usage WHERE cycle_id=?1 OR scheduled_at=c.scheduled_at OR state IN ('reserved','unknown') OR budget_anomaly=1)
      AND (SELECT COALESCE(sum(request_count),0) FROM openai_fallback_usage WHERE reserved_at<strftime('%Y-%m-%dT00:00:00.000Z','now','+1 day') AND accounting_through>=${day})+1<=?3
      AND (SELECT COALESCE(sum(request_count),0) FROM openai_fallback_usage WHERE accounting_through>=${week})+1<=?4
      AND (SELECT COALESCE(sum(request_count),0) FROM openai_fallback_usage WHERE accounting_through>=${month})+1<=?5
      AND (SELECT COALESCE(sum(CASE state WHEN 'exact' THEN total_tokens WHEN 'cancelled_pre_dispatch' THEN 0 ELSE reserved_total END),0) FROM openai_fallback_usage WHERE accounting_through>=${day})+24576<=?6
      AND (SELECT COALESCE(sum(CASE state WHEN 'exact' THEN total_tokens WHEN 'cancelled_pre_dispatch' THEN 0 ELSE reserved_total END),0) FROM openai_fallback_usage WHERE accounting_through>=${week})+24576<=?7
      AND (SELECT COALESCE(sum(CASE state WHEN 'exact' THEN total_tokens WHEN 'cancelled_pre_dispatch' THEN 0 ELSE reserved_total END),0) FROM openai_fallback_usage WHERE accounting_through>=${month})+24576<=?8
      RETURNING cycle_id,attempt_id,scheduled_at,reserved_at`;
    try {
      const row=await this.database.prepare(sql).bind(cycleId,attemptId,limits.dailyRequests,limits.weeklyRequests,limits.monthlyRequests,limits.dailyTokens,limits.weeklyTokens,limits.monthlyTokens).first<{cycle_id:string;attempt_id:string;scheduled_at:string;reserved_at:string}>();
      return row ? { cycleId:row.cycle_id,attemptId:row.attempt_id,scheduledAt:row.scheduled_at,reservedAt:row.reserved_at } : null;
    } catch (error) {
      const existing=await this.read(cycleId).catch(()=>null);
      if (existing) throw new Error("OpenAI fallback reservation outcome is uncertain; no dispatch is authorized.");
      throw error;
    }
  }
  private async transition(ref:LunaReservation,sql:string, values:unknown[], expected:(row:OpenAIFallbackUsageRecord)=>boolean) {
    if(!validateRef(ref)) throw new Error("OpenAI fallback reservation identity is invalid.");
    const result=await this.database.prepare(sql).bind(...values).first<{cycle_id:string}>().catch(()=>null);
    if(result?.cycle_id===ref.cycleId)return;
    const row=await this.read(ref.cycleId);
    if(row&&row.attemptId===ref.attemptId&&row.scheduledAt===ref.scheduledAt&&row.reservedAt===ref.reservedAt&&expected(row))return;
    throw new Error("OpenAI fallback accounting transition could not be confirmed safely.");
  }
  async markIntent(ref:LunaReservation) {
    const sql=`UPDATE openai_fallback_usage SET dispatch_status='intent',started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),accounting_through=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE cycle_id=?1 AND attempt_id=?2 AND scheduled_at=?3 AND reserved_at=?4 AND state='reserved' AND dispatch_status='not_dispatched' AND reserved_at>=strftime('%Y-%m-%dT00:00:00.000Z','now') AND ${proof} RETURNING cycle_id`;
    await this.transition(ref,sql,[ref.cycleId,ref.attemptId,ref.scheduledAt,ref.reservedAt],row=>row.dispatchStatus==="intent"&&row.state==="reserved");
  }
  async markObserved(ref:LunaReservation) {
    await this.transition(ref,"UPDATE openai_fallback_usage SET dispatch_status='observed',accounting_through=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE cycle_id=?1 AND attempt_id=?2 AND scheduled_at=?3 AND reserved_at=?4 AND state='reserved' AND dispatch_status='intent' RETURNING cycle_id",[ref.cycleId,ref.attemptId,ref.scheduledAt,ref.reservedAt],row=>row.dispatchStatus==="observed"&&row.state==="reserved");
  }
  async settleExact(ref:LunaReservation,usage:OpenAIExactUsage,e:LunaEvidence) {
    if(!safe(usage.inputTokens)||!safe(usage.outputTokens)||!safe(usage.totalTokens)||usage.totalTokens!==usage.inputTokens+usage.outputTokens||!validateEvidence(e))throw new Error("OpenAI fallback exact usage is invalid.");
    const anomaly=usage.inputTokens>12288||usage.outputTokens>12288||usage.totalTokens>24576?1:0;
    await this.transition(ref,"UPDATE openai_fallback_usage SET state='exact',input_tokens=?5,output_tokens=?6,total_tokens=?7,failure_class=?8,http_status=?9,duration_ms=?10,budget_anomaly=?11,settled_at=?12,accounting_through=CASE WHEN accounting_through>?12 THEN accounting_through ELSE ?12 END WHERE cycle_id=?1 AND attempt_id=?2 AND scheduled_at=?3 AND reserved_at=?4 AND state='reserved' AND dispatch_status IN ('intent','observed') RETURNING cycle_id",[ref.cycleId,ref.attemptId,ref.scheduledAt,ref.reservedAt,usage.inputTokens,usage.outputTokens,usage.totalTokens,e.outcome,e.httpStatus,e.durationMs,anomaly,e.endedAt],row=>row.state==="exact"&&row.inputTokens===usage.inputTokens&&row.outputTokens===usage.outputTokens&&row.totalTokens===usage.totalTokens);
  }
  async markUnknown(ref:LunaReservation,e:LunaEvidence) {
    if(!validateEvidence(e)||e.outcome==="none")throw new Error("OpenAI fallback unknown evidence is invalid.");
    await this.transition(ref,"UPDATE openai_fallback_usage SET state='unknown',failure_class=?5,http_status=?6,duration_ms=?7,settled_at=?8,accounting_through=CASE WHEN accounting_through>?8 THEN accounting_through ELSE ?8 END WHERE cycle_id=?1 AND attempt_id=?2 AND scheduled_at=?3 AND reserved_at=?4 AND state='reserved' AND dispatch_status IN ('intent','observed') RETURNING cycle_id",[ref.cycleId,ref.attemptId,ref.scheduledAt,ref.reservedAt,e.outcome,e.httpStatus,e.durationMs,e.endedAt],row=>row.state==="unknown"&&row.inputTokens===null);
  }
  async cancelBeforeDispatch(ref:LunaReservation) {
    await this.transition(ref,"UPDATE openai_fallback_usage SET state='cancelled_pre_dispatch',failure_class='not_admitted',settled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),accounting_through=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE cycle_id=?1 AND attempt_id=?2 AND scheduled_at=?3 AND reserved_at=?4 AND state='reserved' AND dispatch_status IN ('not_dispatched','intent') RETURNING cycle_id",[ref.cycleId,ref.attemptId,ref.scheduledAt,ref.reservedAt],row=>row.state==="cancelled_pre_dispatch");
  }
}
