import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentAnalysis, StoredDiscovery } from "../types/index.js";
import { DiscoveryHistoryError, isValidAgentAnalysis, normalizeDiscoveryUrl, type DiscoveryHistory } from "./discoveryHistoryCore.js";
export { DiscoveryHistoryError, isValidAgentAnalysis, normalizeDiscoveryUrl, type DiscoveryHistory } from "./discoveryHistoryCore.js";

interface DiscoveryHistoryData {
  discoveries: StoredDiscovery[];
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function validDiscovery(value: unknown): value is StoredDiscovery {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const discovery = value as Record<string, unknown>;
  if (!nonEmptyString(discovery.normalizedUrl) || !validTimestamp(discovery.firstSeenAt) || !validTimestamp(discovery.lastSeenAt) || !isValidAgentAnalysis(discovery.analysis)) {
    return false;
  }

  try {
    return discovery.normalizedUrl === normalizeDiscoveryUrl(discovery.analysis.sourceUrl);
  } catch {
    return false;
  }
}

function validHistory(value: unknown): value is DiscoveryHistoryData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const discoveries = (value as Record<string, unknown>).discoveries;
  if (!Array.isArray(discoveries) || !discoveries.every(validDiscovery)) return false;
  return new Set(discoveries.map((discovery) => discovery.normalizedUrl)).size === discoveries.length;
}

function copyAnalysis(analysis: AgentAnalysis): AgentAnalysis {
  return { ...analysis, projectOpportunities: [...analysis.projectOpportunities], technologies: [...analysis.technologies] };
}

function copy(discovery: StoredDiscovery): StoredDiscovery {
  return { ...discovery, analysis: copyAnalysis(discovery.analysis) };
}

export class JsonDiscoveryHistory implements DiscoveryHistory {
  constructor(private readonly filePath = resolve(process.cwd(), "data", "discovery-history.json")) {}

  async listDiscoveries(): Promise<StoredDiscovery[]> {
    return (await this.read()).discoveries.map(copy);
  }

  async getDiscovery(url: string): Promise<StoredDiscovery | undefined> {
    const normalizedUrl = normalizeDiscoveryUrl(url);
    const discovery = (await this.read()).discoveries.find((item) => item.normalizedUrl === normalizedUrl);
    return discovery ? copy(discovery) : undefined;
  }

  async hasDiscovery(url: string): Promise<boolean> {
    return (await this.getDiscovery(url)) !== undefined;
  }

  async recordDiscovery(analysis: AgentAnalysis, seenAt = new Date()): Promise<StoredDiscovery> {
    if (!isValidAgentAnalysis(analysis)) throw new DiscoveryHistoryError("Discovery analysis is invalid and cannot be recorded.");
    if (Number.isNaN(seenAt.getTime())) throw new DiscoveryHistoryError("Discovery timestamp is invalid.");

    const normalizedUrl = normalizeDiscoveryUrl(analysis.sourceUrl);
    const data = await this.read();
    const existing = data.discoveries.find((item) => item.normalizedUrl === normalizedUrl);
    if (existing) return copy(existing);

    const timestamp = seenAt.toISOString();
    const discovery: StoredDiscovery = { normalizedUrl, firstSeenAt: timestamp, lastSeenAt: timestamp, analysis: copyAnalysis(analysis) };
    await this.write({ discoveries: [...data.discoveries, discovery] });
    return copy(discovery);
  }

  async touchDiscovery(url: string, seenAt = new Date()): Promise<StoredDiscovery | undefined> {
    if (Number.isNaN(seenAt.getTime())) throw new DiscoveryHistoryError("Discovery timestamp is invalid.");
    const normalizedUrl = normalizeDiscoveryUrl(url);
    const data = await this.read();
    const index = data.discoveries.findIndex((item) => item.normalizedUrl === normalizedUrl);
    if (index === -1) return undefined;

    const updated: StoredDiscovery = { ...data.discoveries[index], lastSeenAt: seenAt.toISOString() };
    const discoveries = [...data.discoveries];
    discoveries[index] = updated;
    await this.write({ discoveries });
    return copy(updated);
  }

  private async read(): Promise<DiscoveryHistoryData> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!validHistory(value)) throw new DiscoveryHistoryError("Discovery history file has an invalid format.");
      return value;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { discoveries: [] };
      if (error instanceof SyntaxError) throw new DiscoveryHistoryError("Discovery history file contains invalid JSON.");
      if (error instanceof DiscoveryHistoryError) throw error;
      throw new DiscoveryHistoryError("Discovery history file could not be read safely.");
    }
  }

  private async write(data: DiscoveryHistoryData): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}
