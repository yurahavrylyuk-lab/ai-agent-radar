import {
  DiscoveryHistoryError,
  isValidAgentAnalysis,
  normalizeDiscoveryUrl,
  validateRecentDiscoveryQuery,
  type DiscoveryHistory,
  type RecentDiscoveryQuery,
  type RecentDiscoveryResult,
} from "./discoveryHistoryCore.js";
import type { AgentAnalysis, StoredDiscovery } from "../types/index.js";

interface DiscoveryRow {
  normalized_url: string;
  first_seen_at: string;
  last_seen_at: string;
  analysis_json: string;
}

function copyAnalysis(analysis: AgentAnalysis): AgentAnalysis {
  return { ...analysis, projectOpportunities: [...analysis.projectOpportunities], technologies: [...analysis.technologies] };
}

function copy(discovery: StoredDiscovery): StoredDiscovery {
  return { ...discovery, analysis: copyAnalysis(discovery.analysis) };
}

function isTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function discoveryFromRow(row: DiscoveryRow): StoredDiscovery {
  if (!row.normalized_url || !isTimestamp(row.first_seen_at) || !isTimestamp(row.last_seen_at)) {
    throw new DiscoveryHistoryError("D1 discovery history contains an invalid record.");
  }

  let analysis: unknown;
  try {
    analysis = JSON.parse(row.analysis_json);
  } catch {
    throw new DiscoveryHistoryError("D1 discovery history contains invalid analysis JSON.");
  }

  if (!isValidAgentAnalysis(analysis) || row.normalized_url !== normalizeDiscoveryUrl(analysis.sourceUrl)) {
    throw new DiscoveryHistoryError("D1 discovery history contains an invalid record.");
  }

  return {
    normalizedUrl: row.normalized_url,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    analysis: copyAnalysis(analysis),
  };
}

/** D1 implementation of the discovery-history persistence boundary. */
export class D1DiscoveryHistory implements DiscoveryHistory {
  constructor(private readonly database: D1Database) {}

  async listDiscoveries(): Promise<StoredDiscovery[]> {
    try {
      const result = await this.database.prepare(
        "SELECT normalized_url, first_seen_at, last_seen_at, analysis_json FROM discoveries ORDER BY first_seen_at ASC",
      ).all<DiscoveryRow>();
      return (result.results ?? []).map(discoveryFromRow).map(copy);
    } catch (error) {
      if (error instanceof DiscoveryHistoryError) throw error;
      throw new DiscoveryHistoryError("D1 discovery history could not be read safely.");
    }
  }

  async getDiscovery(url: string): Promise<StoredDiscovery | undefined> {
    const normalizedUrl = normalizeDiscoveryUrl(url);
    try {
      const row = await this.database.prepare(
        "SELECT normalized_url, first_seen_at, last_seen_at, analysis_json FROM discoveries WHERE normalized_url = ?1",
      ).bind(normalizedUrl).first<DiscoveryRow>();
      return row ? copy(discoveryFromRow(row)) : undefined;
    } catch (error) {
      if (error instanceof DiscoveryHistoryError) throw error;
      throw new DiscoveryHistoryError("D1 discovery history could not be read safely.");
    }
  }

  async listRecentDiscoveries(query: RecentDiscoveryQuery): Promise<RecentDiscoveryResult> {
    validateRecentDiscoveryQuery(query);
    try {
      const result = await this.database.prepare(
        "SELECT normalized_url, first_seen_at, last_seen_at, analysis_json FROM discoveries "
        + "WHERE first_seen_at >= ?1 AND first_seen_at < ?2 "
        + "ORDER BY first_seen_at DESC, normalized_url ASC LIMIT ?3",
      ).bind(query.fromInclusive, query.beforeExclusive, query.limit + 1).all<DiscoveryRow>();
      const discoveries = (result.results ?? []).map(discoveryFromRow);
      return {
        discoveries: discoveries.slice(0, query.limit).map(copy),
        truncated: discoveries.length > query.limit,
      };
    } catch (error) {
      if (error instanceof DiscoveryHistoryError) throw error;
      throw new DiscoveryHistoryError("D1 recent discovery history could not be read safely.");
    }
  }

  async hasDiscovery(url: string): Promise<boolean> {
    return (await this.getDiscovery(url)) !== undefined;
  }

  async recordDiscovery(analysis: AgentAnalysis, seenAt = new Date()): Promise<StoredDiscovery> {
    if (!isValidAgentAnalysis(analysis)) throw new DiscoveryHistoryError("Discovery analysis is invalid and cannot be recorded.");
    if (Number.isNaN(seenAt.getTime())) throw new DiscoveryHistoryError("Discovery timestamp is invalid.");

    const normalizedUrl = normalizeDiscoveryUrl(analysis.sourceUrl);
    const timestamp = seenAt.toISOString();
    try {
      await this.database.prepare(
        "INSERT OR IGNORE INTO discoveries (normalized_url, first_seen_at, last_seen_at, analysis_json) VALUES (?1, ?2, ?3, ?4)",
      ).bind(normalizedUrl, timestamp, timestamp, JSON.stringify(copyAnalysis(analysis))).run();
      const discovery = await this.getDiscovery(normalizedUrl);
      if (!discovery) throw new DiscoveryHistoryError("Recorded D1 discovery could not be retrieved safely.");
      return discovery;
    } catch (error) {
      if (error instanceof DiscoveryHistoryError) throw error;
      throw new DiscoveryHistoryError("D1 discovery history could not be written safely.");
    }
  }

  async touchDiscovery(url: string, seenAt = new Date()): Promise<StoredDiscovery | undefined> {
    if (Number.isNaN(seenAt.getTime())) throw new DiscoveryHistoryError("Discovery timestamp is invalid.");
    const normalizedUrl = normalizeDiscoveryUrl(url);
    try {
      await this.database.prepare(
        "UPDATE discoveries SET last_seen_at = ?1 WHERE normalized_url = ?2",
      ).bind(seenAt.toISOString(), normalizedUrl).run();
      return this.getDiscovery(normalizedUrl);
    } catch (error) {
      if (error instanceof DiscoveryHistoryError) throw error;
      throw new DiscoveryHistoryError("D1 discovery history could not be written safely.");
    }
  }
}
