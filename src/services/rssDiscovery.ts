import { SaxesParser, type SaxesTagNS } from "saxes";

import { isApprovedRssArticleUrl, RSS_FEEDS, RSS_LIMITS, validateRssFeeds, type RssFeedDefinition } from "../config/rssSources.js";
import type { RssCycleMetrics, RssDiscoveryResult, RssFailureReason, SearchResult } from "../types/index.js";
import { truncateUtf8, utf8Length } from "./batchPrompt.js";

const ATOM_NS = "http://www.w3.org/2005/Atom";

export interface RssParseResult {
  positions: Array<{ itemOrdinal: number; result: SearchResult | null }>;
  rejectedItems: number;
  itemsTruncated: boolean;
}


export class RssDocumentError extends Error {
  constructor(readonly reason: "parse" | "structure") { super(`RSS ${reason} failure`); }
}

interface XmlNode {
  local: string;
  uri: string;
  attributes: Record<string, string>;
  text: string;
  children: XmlNode[];
}

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function oneChild(node: XmlNode, local: string, uri: string): XmlNode | undefined {
  const found = node.children.filter(child => child.local === local && child.uri === uri);
  return found.length === 1 ? found[0] : undefined;
}

function children(node: XmlNode, local: string, uri: string): XmlNode[] {
  return node.children.filter(child => child.local === local && child.uri === uri);
}

function safeDate(value: string, now: Date, atom: boolean): string | undefined {
  const text = normalizedText(value);
  const timezone = atom ? /(?:Z|[+-]\d{2}:\d{2})$/ : /(?:GMT|UTC|[+-]\d{4})$/i;
  if (!timezone.test(text)) return undefined;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime()) || parsed > now || now.getTime() - parsed.getTime() > RSS_LIMITS.ageMs) return undefined;
  return parsed.toISOString();
}

function resolvedArticleUrl(value: string, feed: RssFeedDefinition, xmlBasePresent: boolean): string | undefined {
  const text = normalizedText(value);
  if (!text) return undefined;
  let absolute: URL;
  try {
    const direct = new URL(text);
    absolute = direct;
  } catch {
    if (xmlBasePresent) return undefined;
    try { absolute = new URL(text, feed.endpoint); } catch { return undefined; }
  }
  const result = absolute.toString();
  return isApprovedRssArticleUrl(result, feed) ? result : undefined;
}

function safeTitle(node: XmlNode | undefined): string | undefined {
  if (!node || node.children.length > 0) return undefined;
  const title = normalizedText(node.text);
  if (!title || /[<>]/.test(title)) return undefined;
  return truncateUtf8(title, RSS_LIMITS.titleBytes);
}

function safeSnippet(node: XmlNode | undefined): string | undefined {
  if (!node || node.children.length > 0) return undefined;
  const snippet = normalizedText(node.text);
  if (!snippet || /[<>]/.test(snippet)) return undefined;
  return truncateUtf8(snippet, RSS_LIMITS.snippetBytes);
}

function parseRssItem(item: XmlNode, feed: RssFeedDefinition, now: Date, xmlBasePresent: boolean): SearchResult | null {
  const title = safeTitle(oneChild(item, "title", ""));
  const link = oneChild(item, "link", "");
  const url = link && link.children.length === 0 ? resolvedArticleUrl(link.text, feed, xmlBasePresent) : undefined;
  const date = oneChild(item, "pubDate", "");
  const publishedAt = date && date.children.length === 0 ? safeDate(date.text, now, false) : undefined;
  if (!title || !url || !publishedAt) return null;
  const snippet = safeSnippet(oneChild(item, "description", ""));
  return { title, url, ...(snippet ? { snippet } : {}), publishedAt, source: feed.label };
}

function parseAtomEntry(entry: XmlNode, feed: RssFeedDefinition, now: Date, xmlBasePresent: boolean): SearchResult | null {
  const titleNode = oneChild(entry, "title", ATOM_NS);
  const titleType = titleNode?.attributes.type?.toLowerCase();
  const title = titleType === "xhtml" ? undefined : safeTitle(titleNode);
  const alternates = children(entry, "link", ATOM_NS).filter(link => {
    const rel = (link.attributes.rel ?? "alternate").toLowerCase();
    const type = (link.attributes.type ?? "text/html").toLowerCase();
    return rel === "alternate" && type === "text/html" && typeof link.attributes.href === "string";
  });
  const url = alternates.length === 1 ? resolvedArticleUrl(alternates[0]!.attributes.href!, feed, xmlBasePresent) : undefined;
  const dateNode = oneChild(entry, "published", ATOM_NS) ?? oneChild(entry, "updated", ATOM_NS);
  const publishedAt = dateNode && dateNode.children.length === 0 ? safeDate(dateNode.text, now, true) : undefined;
  if (!title || !url || !publishedAt) return null;
  const snippet = safeSnippet(oneChild(entry, "summary", ATOM_NS));
  return { title, url, ...(snippet ? { snippet } : {}), publishedAt, source: feed.label };
}

/** Parses a complete bounded RSS 2.0 or namespace-correct Atom 1.0 document. */
export function parseRssFeed(xml: string, feed: RssFeedDefinition, now: Date): RssParseResult {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new RssDocumentError("structure");
  let root: XmlNode | undefined;
  const stack: XmlNode[] = [];
  let elements = 0;
  let xmlBasePresent = false;
  let unsafeDeclaration = false;
  let parseFailure = false;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => { unsafeDeclaration = true; });
  parser.on("opentag", (raw: SaxesTagNS) => {
    elements += 1;
    if (elements > RSS_LIMITS.elements || stack.length + 1 > RSS_LIMITS.depth) throw new RssDocumentError("structure");
    const attributes: Record<string, string> = {};
    for (const [name, attribute] of Object.entries(raw.attributes)) {
      const value = attribute.value;
      if (utf8Length(value) > RSS_LIMITS.fieldBytes) throw new RssDocumentError("structure");
      attributes[name] = value;
      if (name === "xml:base" || (attribute.uri === "http://www.w3.org/XML/1998/namespace" && attribute.local === "base")) xmlBasePresent = true;
    }
    const node: XmlNode = { local: raw.local, uri: raw.uri, attributes, text: "", children: [] };
    if (stack.length === 0) {
      if (root) throw new RssDocumentError("structure");
      root = node;
    } else stack.at(-1)!.children.push(node);
    stack.push(node);
  });
  const append = (text: string) => {
    const node = stack.at(-1);
    if (!node) return;
    node.text += text;
    if (utf8Length(node.text) > RSS_LIMITS.fieldBytes) throw new RssDocumentError("structure");
  };
  parser.on("text", append);
  parser.on("cdata", append);
  parser.on("closetag", () => { stack.pop(); });
  parser.on("error", () => { parseFailure = true; });
  try { parser.write(xml).close(); }
  catch (error) {
    if (error instanceof RssDocumentError) throw error;
    throw new RssDocumentError("parse");
  }
  if (parseFailure || unsafeDeclaration || !root || stack.length !== 0) throw new RssDocumentError(parseFailure ? "parse" : "structure");

  let items: XmlNode[];
  let parseItem: (item: XmlNode) => SearchResult | null;
  if (root.local === "rss" && root.uri === "") {
    const channels = children(root, "channel", "");
    if (channels.length !== 1) throw new RssDocumentError("structure");
    items = children(channels[0]!, "item", "");
    parseItem = item => parseRssItem(item, feed, now, xmlBasePresent);
  } else if (root.local === "feed" && root.uri === ATOM_NS) {
    items = children(root, "entry", ATOM_NS);
    parseItem = item => parseAtomEntry(item, feed, now, xmlBasePresent);
  } else throw new RssDocumentError("structure");

  const positions = items.slice(0, RSS_LIMITS.itemsPerFeed).map((item, index) => ({ itemOrdinal: index + 1, result: parseItem(item) }));
  return {
    positions,
    rejectedItems: positions.filter(position => position.result === null).length,
    itemsTruncated: items.length > RSS_LIMITS.itemsPerFeed,
  };
}

function emptyMetrics(status: RssCycleMetrics["status"], configuredFeeds: number): RssCycleMetrics {
  return {
    status, configuredFeeds, attemptedFeeds: 0, succeededFeeds: 0, failedFeeds: 0,
    observedPositions: 0, validCandidates: 0, rejectedItems: 0, itemLimitTruncations: 0, outcomes: [],
  };
}

function xmlMediaType(response: Response): boolean {
  const raw = response.headers.get("content-type") ?? "";
  const parts = raw.split(";").map(part => part.trim().toLowerCase());
  if (!["application/rss+xml", "application/atom+xml", "application/xml", "text/xml"].includes(parts[0] ?? "")) return false;
  const charsets = parts.slice(1).filter(part => part.startsWith("charset="));
  return charsets.length <= 1 && (charsets.length === 0 || charsets[0] === "charset=utf-8" || charsets[0] === "charset=\"utf-8\"");
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("Timed out", "AbortError");
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new DOMException("Timed out", "AbortError"));
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { if (rejectAbort) signal.removeEventListener("abort", rejectAbort); }
}

async function boundedXml(response: Response, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > RSS_LIMITS.bodyBytes)) throw new RssDocumentError("structure");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Timed out", "AbortError");
      const read = await withAbort(reader.read(), signal);
      const { done, value } = read;
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RSS_LIMITS.bodyBytes) throw new RangeError("RSS body limit exceeded");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  } catch (error) {
    try {
      void reader.cancel().catch(() => { /* cancellation cannot replace the primary failure */ });
    } catch { /* synchronous cancellation failure cannot replace the primary failure */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Collects approved feeds sequentially; no acquisition failure escapes this boundary. */
export async function collectRss(options: { now: Date; fetch: typeof fetch; feeds?: readonly RssFeedDefinition[] }): Promise<RssDiscoveryResult> {
  const feeds = options.feeds ?? RSS_FEEDS;
  try { validateRssFeeds(feeds); }
  catch { return { observations: [], metrics: emptyMetrics("configuration", feeds.length) }; }
  if (feeds.length === 0) return { observations: [], metrics: emptyMetrics("disabled", 0) };
  const metrics = emptyMetrics("collected", feeds.length);
  const observations: RssDiscoveryResult["observations"] = [];
  for (const feed of feeds) {
    const started = Date.now();
    metrics.attemptedFeeds += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RSS_LIMITS.timeoutMs);
    let reason: RssFailureReason = "http";
    let httpStatus: number | undefined;
    try {
      const response = await withAbort(options.fetch(feed.endpoint, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
        headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
      }), controller.signal);
      httpStatus = response.status;
      if (response.redirected) { reason = "redirect"; throw new Error("redirect"); }
      if (!response.ok) { reason = "http"; throw new Error("http"); }
      if (!xmlMediaType(response)) { reason = "encoding"; throw new Error("encoding"); }
      const declared = response.headers.get("content-length");
      if (declared !== null && Number(declared) > RSS_LIMITS.bodyBytes) { reason = "body_limit"; throw new Error("body_limit"); }
      let xml: string;
      try { xml = await boundedXml(response, controller.signal); }
      catch (error) {
        if (controller.signal.aborted) reason = "timeout";
        else if (error instanceof RangeError || error instanceof RssDocumentError) reason = "body_limit";
        else reason = "encoding";
        throw error;
      }
      let parsed: RssParseResult;
      try { parsed = parseRssFeed(xml, feed, options.now); }
      catch (error) { reason = error instanceof RssDocumentError ? error.reason : "parse"; throw error; }
      for (const position of parsed.positions) observations.push({ result: position.result, provenance: { kind: "rss", feedId: feed.id, itemOrdinal: position.itemOrdinal } });
      metrics.succeededFeeds += 1;
      metrics.observedPositions += parsed.positions.length;
      metrics.validCandidates += parsed.positions.filter(position => position.result !== null).length;
      metrics.rejectedItems += parsed.rejectedItems;
      metrics.itemLimitTruncations += parsed.itemsTruncated ? 1 : 0;
      reason = "ok";
    } catch {
      metrics.failedFeeds += 1;
      if (controller.signal.aborted) reason = "timeout";
    } finally {
      clearTimeout(timer);
      metrics.outcomes.push({ feedId: feed.id, reason, ...(reason === "http" && httpStatus !== undefined ? { httpStatus } : {}), elapsedMs: Math.max(0, Date.now() - started) });
    }
  }
  return { observations, metrics };
}
