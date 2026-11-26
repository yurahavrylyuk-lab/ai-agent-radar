export function validGatewayKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export class GatewayBodyTooLarge extends Error {}

export async function readGatewayJson(message: Request | Response, limit: number): Promise<unknown> {
  const reader = message.body?.getReader();
  if (!reader) throw new Error("Gateway body is missing.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let json = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new GatewayBodyTooLarge();
      json += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(json + decoder.decode()) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
