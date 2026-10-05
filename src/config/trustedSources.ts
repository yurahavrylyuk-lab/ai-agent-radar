export interface TrustedSourceRegistry {
  readonly version: 1;
  readonly approvedHostnames: readonly string[];
}

/** Human-approved exact hostnames eligible for P4 fallback delivery. */
export const TRUSTED_SOURCE_REGISTRY: TrustedSourceRegistry = Object.freeze({
  version: 1,
  approvedHostnames: Object.freeze([
    "openai.com",
    "developers.openai.com",
    "platform.openai.com",
    "anthropic.com",
    "docs.anthropic.com",
    "blog.google",
    "ai.google.dev",
    "github.blog",
    "github.com",
    "devblogs.microsoft.com",
    "learn.microsoft.com",
    "aws.amazon.com",
    "cloud.google.com",
    "azure.microsoft.com",
    "kubernetes.io",
    "nodejs.org",
    "python.org",
    "go.dev",
    "www.rust-lang.org",
    "www.typescriptlang.org",
  ]),
});
