import { batchGatewayOperations, InvalidGatewayRequest, type BatchGatewayOperations } from "./services/batchGatewayOperations.js";
import { readGatewayJson, GatewayBodyTooLarge, validGatewayKey } from "./services/batchGatewayWire.js";

interface GatewayEnvironment {
  DB: D1Database;
  BATCH_GATEWAY_KEY?: string;
}
const encoder = new TextEncoder();
const challenge = encoder.encode("ai-radar/batch-gateway/v1");
const hmac = { name: "HMAC", hash: "SHA-256" };

async function authorized(request: Request, secret: string | undefined): Promise<boolean> {
  const header = request.headers.get("authorization");
  if (!validGatewayKey(secret) || !header?.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  if (!validGatewayKey(supplied)) return false;
  const native = (crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean }).timingSafeEqual;
  if (native) return native.call(crypto.subtle, encoder.encode(supplied), encoder.encode(secret));
  // Node's local Web Crypto fixture lacks the Workerd comparison primitive.
  const suppliedKey = await crypto.subtle.importKey("raw", encoder.encode(supplied), hmac, false, ["sign"]);
  const expectedKey = await crypto.subtle.importKey("raw", encoder.encode(secret), hmac, false, ["verify"]);
  return crypto.subtle.verify("HMAC", expectedKey, await crypto.subtle.sign("HMAC", suppliedKey, challenge), challenge);
}

const headers = { "cache-control": "no-store" };
const fail = (status: number) => new Response(null, { status, headers });

export async function handleBatchGateway(request: Request, env: GatewayEnvironment): Promise<Response> {
  if (!await authorized(request, env.BATCH_GATEWAY_KEY)) return fail(401);
  if (request.method !== "POST") return fail(405);
  const target = new URL(request.url);
  if (target.pathname !== "/v1/batch" || target.search) return fail(404);
  let parsed: unknown;
  try { parsed = await readGatewayJson(request, 448 * 1024); }
  catch (error) { return fail(error instanceof GatewayBodyTooLarge ? 413 : 400); }
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length !== 2) return fail(400);
  const { op, args } = parsed as Record<string, unknown>;
  if (typeof op !== "string" || !Array.isArray(args)) return fail(400);
  try {
    const operations = batchGatewayOperations(env.DB);
    if (!Object.hasOwn(operations, op)) return fail(400);
    const result = await operations[op as keyof BatchGatewayOperations].invoke(args);
    const envelope = result instanceof Map ? { kind: "map", value: [...result] }
      : result === undefined ? { kind: "void" } : { kind: "value", value: result };
    return Response.json(envelope, { headers });
  } catch (error) {
    return fail(error instanceof InvalidGatewayRequest ? 400 : 503);
  }
}

export default { fetch: handleBatchGateway };
