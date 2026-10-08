export interface ApprovedXSource {
  readonly userId: string;
  readonly approvedHandle: string;
  readonly label: string;
  readonly category: "ai_lab" | "developer_platform" | "technology_company";
}

export const X_SOURCE_REGISTRY_VERSION = "2026-10-08";
export const X_PRICE_VERIFIED_AT = "2026-10-08T00:00:00.000Z";
export const X_PRICE_EXPIRES_AT = "2026-11-08T00:00:00.000Z";
export const X_POST_READ_MICRO_USD = 5_000;

/** Human-approved P6 v1 polling registry. Identity is the opaque decimal userId. */
export const APPROVED_X_SOURCES: readonly ApprovedXSource[] = Object.freeze([
  Object.freeze({ userId: "4398626122", approvedHandle: "OpenAI", label: "OpenAI", category: "ai_lab" }),
  Object.freeze({ userId: "1353836358901501952", approvedHandle: "AnthropicAI", label: "Anthropic", category: "ai_lab" }),
  Object.freeze({ userId: "4783690002", approvedHandle: "GoogleDeepMind", label: "Google DeepMind", category: "ai_lab" }),
  Object.freeze({ userId: "13334762", approvedHandle: "github", label: "GitHub", category: "developer_platform" }),
  Object.freeze({ userId: "74286565", approvedHandle: "Microsoft", label: "Microsoft", category: "technology_company" }),
]);

export const X_USAGE_LIMITS = Object.freeze({
  requestsPerCycle: 5,
  requestsPerDay: 5,
  requestsPerIsoWeek: 35,
  requestsPerMonth: 155,
  reservedPostsPerRequest: 10,
  reservedPostsPerMonth: 1_550,
  reservedMicroUsdPerMonth: 8_000_000,
});

export function validateXSourceRegistry(sources: readonly ApprovedXSource[] = APPROVED_X_SOURCES): void {
  if (sources.length < 1 || sources.length > 5) throw new Error("X source registry must contain from one to five approved accounts.");
  const ids = new Set<string>();
  for (const source of sources) {
    if (!/^[1-9]\d{0,24}$/.test(source.userId)) throw new Error("X source user IDs must be non-zero decimal strings.");
    if (ids.has(source.userId)) throw new Error("X source registry contains a duplicate user ID.");
    if (!source.approvedHandle.trim() || !source.label.trim()) throw new Error("X source metadata must be non-empty.");
    ids.add(source.userId);
  }
}

export function isXDiscoveryEnabled(environment: Record<string, string | undefined>): boolean {
  const value = environment.X_DISCOVERY_ENABLED?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error("X_DISCOVERY_ENABLED must be true or false when configured.");
}
