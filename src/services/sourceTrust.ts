import { TRUSTED_SOURCE_REGISTRY, type TrustedSourceRegistry } from "../config/trustedSources.js";

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_ADDRESS = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function canonicalDnsHostname(value: string): string | undefined {
  const hostname = value.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.length > 253 || hostname.startsWith("[") || IPV4_ADDRESS.test(hostname)) {
    return undefined;
  }

  const labels = hostname.split(".");
  if (labels.length < 2 || labels.some((label) => !DNS_LABEL.test(label))) return undefined;
  return hostname;
}

function registryHostnames(registry: TrustedSourceRegistry): ReadonlySet<string> | undefined {
  if (registry.version !== 1 || !Array.isArray(registry.approvedHostnames)) return undefined;

  const hostnames = new Set<string>();
  for (const hostname of registry.approvedHostnames) {
    const canonical = typeof hostname === "string" ? canonicalDnsHostname(hostname) : undefined;
    if (!canonical || canonical !== hostname || hostnames.has(hostname)) return undefined;
    hostnames.add(hostname);
  }
  return hostnames;
}

/**
 * Returns whether a source URL has an exact hostname match in the approved P4
 * registry. Invalid URLs or registry state fail closed.
 */
export function isTrustedFallbackSource(
  sourceUrl: string,
  registry: TrustedSourceRegistry = TRUSTED_SOURCE_REGISTRY,
): boolean {
  try {
    const approvedHostnames = registryHostnames(registry);
    if (!approvedHostnames) return false;

    const parsed = new URL(sourceUrl);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
        parsed.username || parsed.password || parsed.port) {
      return false;
    }

    const hostname = canonicalDnsHostname(parsed.hostname);
    return hostname !== undefined && approvedHostnames.has(hostname);
  } catch {
    return false;
  }
}
