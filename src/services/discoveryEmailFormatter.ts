import type { DiscoveryEmailContent, StoredDiscovery } from "../types/index.js";

const SUBJECT_PREFIX = "AI Agent Radar: ";
const MAX_SUBJECT_NAME_LENGTH = 100;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}

function safeHref(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : "#";
  } catch {
    return "#";
  }
}

function subjectFor(name: string): string {
  return `${SUBJECT_PREFIX}${name.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_SUBJECT_NAME_LENGTH)}`;
}

function textList(items: string[]): string {
  return items.length ? items.map((item) => `* ${item}`).join("\n") : "* None";
}

function htmlList(items: string[]): string {
  return `<ul>${items.length ? items.map((item) => `<li>${escapeHtml(item)}</li>`).join("") : "<li>None</li>"}</ul>`;
}

/** Formats a stored discovery without deciding eligibility or delivering email. */
export function formatDiscoveryEmail(discovery: StoredDiscovery): DiscoveryEmailContent {
  const analysis = discovery.analysis;
  const sourceUrl = analysis.sourceUrl;

  return {
    subject: subjectFor(analysis.name),
    text: `${subjectFor(analysis.name)}

Category: ${analysis.category}
Relevance: ${analysis.relevanceScore}/10

Summary:
${analysis.summary}

Why it matters:
${analysis.whyItMatters}

Educational value:
${analysis.educationalValue}

Project opportunities:
${textList(analysis.projectOpportunities)}

Technologies:
${analysis.technologies.join(", ") || "None"}

Original source: ${analysis.sourceTitle}
Source URL: ${sourceUrl}`,
    html: `<!doctype html><html><body>
<h1>${escapeHtml(analysis.name)}</h1>
<p><strong>Category:</strong> ${escapeHtml(analysis.category)}<br><strong>Relevance:</strong> ${analysis.relevanceScore}/10</p>
<h2>Summary</h2><p>${escapeHtml(analysis.summary)}</p>
<h2>Why it matters</h2><p>${escapeHtml(analysis.whyItMatters)}</p>
<h2>Educational value</h2><p>${escapeHtml(analysis.educationalValue)}</p>
<h2>Project opportunities</h2>${htmlList(analysis.projectOpportunities)}
<h2>Technologies</h2><p>${analysis.technologies.length ? analysis.technologies.map(escapeHtml).join(", ") : "None"}</p>
<h2>Original source</h2><p>${escapeHtml(analysis.sourceTitle)}<br><a href="${escapeHtml(safeHref(sourceUrl))}">${escapeHtml(sourceUrl)}</a></p>
</body></html>`,
  };
}
