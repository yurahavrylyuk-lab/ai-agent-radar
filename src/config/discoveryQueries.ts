export const MONITORING_FRESHNESS = "pw" as const;

export type DiscoveryQueryKind = "official" | "broad";

export interface DiscoveryQueryDescriptor {
  readonly id: string;
  readonly query: string;
  readonly kind: DiscoveryQueryKind;
  readonly officialHostnames?: readonly string[];
}

/** The fixed, bounded daily discovery allocation. */
export const DISCOVERY_QUERY_DESCRIPTORS = [
  { id: "official_openai", query: "site:openai.com", kind: "official", officialHostnames: ["openai.com", "www.openai.com", "developers.openai.com", "platform.openai.com"] },
  { id: "broad_codex", query: "Codex AI coding assistant developer features releases workflows", kind: "broad" },
  { id: "official_anthropic", query: "site:anthropic.com", kind: "official", officialHostnames: ["anthropic.com", "www.anthropic.com", "docs.anthropic.com"] },
  { id: "broad_claude_code", query: "Claude Code AI coding assistant developer features releases workflows", kind: "broad" },
  { id: "official_google", query: "site:blog.google OR site:ai.google.dev", kind: "official", officialHostnames: ["blog.google", "ai.google.dev"] },
  { id: "broad_ai", query: "AI news model releases open-source agents frameworks SDK MCP developer tools", kind: "broad" },
  { id: "official_github", query: "site:github.blog", kind: "official", officialHostnames: ["github.blog"] },
  { id: "broad_programming", query: "programming language compiler standard library IDE CLI CI/CD code review releases", kind: "broad" },
  { id: "official_microsoft", query: "site:devblogs.microsoft.com OR site:learn.microsoft.com", kind: "official", officialHostnames: ["devblogs.microsoft.com", "learn.microsoft.com"] },
  { id: "broad_infrastructure", query: "cloud DevOps Kubernetes networking security advisories developer productivity tutorials", kind: "broad" },
] as const satisfies readonly DiscoveryQueryDescriptor[];

/** Compatibility export for callers that only need the ten query strings. */
export const MONITORING_QUERIES = DISCOVERY_QUERY_DESCRIPTORS.map(({ query }) => query);
