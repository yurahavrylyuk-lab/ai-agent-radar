import type { DiscoveryEmailContent, StoredDiscovery } from "../types/index.js";

const SUBJECT_PREFIX = "AI Agent Radar: ";
const MAX_SUBJECT_NAME_LENGTH = 100;
const EMAIL_BACKGROUND = "#090d16";
const CARD_BACKGROUND = "#111827";
const PANEL_BACKGROUND = "#182235";
const PRIMARY_TEXT = "#f8fafc";
const SECONDARY_TEXT = "#a8b3c7";
const ACCENT = "#78a9ff";

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

function categoryLabel(category: string): string {
  return category
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function textList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

function projectIdeaRows(items: string[]): string {
  if (!items.length) {
    return `<tr><td style="padding: 12px 14px; color: ${SECONDARY_TEXT}; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 22px;">No project ideas identified.</td></tr>`;
  }

  return items
    .map(
      (item) => `<tr><td style="padding: 12px 14px; border-top: 1px solid #2a3954; color: ${PRIMARY_TEXT}; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 22px;"><span style="color: ${ACCENT}; font-weight: 700;">&#8594;</span>&nbsp; ${escapeHtml(item)}</td></tr>`,
    )
    .join("");
}

function technologyBadges(items: string[]): string {
  return items.length
    ? items
        .map(
          (item) => `<span style="display: inline-block; margin: 0 6px 7px 0; padding: 6px 9px; border: 1px solid #3b4b67; border-radius: 999px; background-color: #1d2a40; color: #dbeafe; font-family: Arial, Helvetica, sans-serif; font-size: 13px; line-height: 16px;">${escapeHtml(item)}</span>`,
        )
        .join("")
    : `<span style="color: ${SECONDARY_TEXT}; font-family: Arial, Helvetica, sans-serif; font-size: 15px;">None</span>`;
}

function sectionLabel(value: string): string {
  return `<p style="margin: 0 0 8px; color: ${ACCENT}; font-family: Arial, Helvetica, sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 1.2px; line-height: 16px; text-transform: uppercase;">${value}</p>`;
}

/** Formats a stored discovery without deciding eligibility or delivering email. */
export function formatDiscoveryEmail(discovery: StoredDiscovery): DiscoveryEmailContent {
  const analysis = discovery.analysis;
  const sourceUrl = analysis.sourceUrl;
  const href = safeHref(sourceUrl);
  const escapedHref = escapeHtml(href);
  const escapedSourceUrl = escapeHtml(sourceUrl);
  const category = categoryLabel(analysis.category);

  return {
    subject: subjectFor(analysis.name),
    text: `${subjectFor(analysis.name)}

NEW DISCOVERY
Category: ${category}
Relevance: ${analysis.relevanceScore}/10

SUMMARY
${analysis.summary}

WHY IT MATTERS
${analysis.whyItMatters}

WHAT YOU CAN LEARN
${analysis.educationalValue}

PROJECT IDEAS
${textList(analysis.projectOpportunities)}

TECHNOLOGIES
${analysis.technologies.join(", ") || "None"}

ORIGINAL SOURCE
${analysis.sourceTitle}
${sourceUrl}

AI Agent Radar
Automated AI discovery monitor`,
    html: `<!doctype html>
<html lang="en">
  <body style="margin: 0; padding: 0; background-color: ${EMAIL_BACKGROUND};">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background-color: ${EMAIL_BACKGROUND};">
      <tr>
        <td align="center" style="padding: 28px 14px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 640px; border: 1px solid #26344d; border-radius: 16px; background-color: ${CARD_BACKGROUND}; overflow: hidden;">
            <tr>
              <td style="padding: 30px 30px 24px; border-bottom: 1px solid #26344d;">
                <p style="margin: 0 0 6px; color: ${PRIMARY_TEXT}; font-family: Arial, Helvetica, sans-serif; font-size: 18px; font-weight: 700; letter-spacing: 1.6px; line-height: 24px;">AI AGENT RADAR</p>
                <p style="margin: 0; color: ${SECONDARY_TEXT}; font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 20px;">New discovery</p>
              </td>
            </tr>
            <tr>
              <td style="padding: 28px 30px 30px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; margin: 0 0 22px;">
                  <tr>
                    <td valign="top">
                      <span style="display: inline-block; padding: 7px 10px; border: 1px solid #3b4b67; border-radius: 999px; background-color: #1d2a40; color: #dbeafe; font-family: Arial, Helvetica, sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 0.5px; line-height: 16px; text-transform: uppercase;">${escapeHtml(category)}</span>
                    </td>
                    <td align="right" valign="top">
                      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border: 1px solid #315b9f; border-radius: 10px; background-color: #172b4d;">
                        <tr>
                          <td style="padding: 7px 10px; color: ${PRIMARY_TEXT}; font-family: Arial, Helvetica, sans-serif; font-size: 15px; font-weight: 700; line-height: 18px;">${analysis.relevanceScore}/10 <span style="color: #a9c8ff; font-size: 12px; font-weight: 400;">relevance</span></td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <h1 style="margin: 0 0 12px; color: ${PRIMARY_TEXT}; font-family: Arial, Helvetica, sans-serif; font-size: 28px; font-weight: 700; letter-spacing: -0.3px; line-height: 34px;">${escapeHtml(analysis.name)}</h1>
                <p style="margin: 0 0 28px; color: ${SECONDARY_TEXT}; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 24px;">${escapeHtml(analysis.summary)}</p>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%;">
                  <tr><td style="padding: 22px 0; border-top: 1px solid #26344d;">${sectionLabel("Why it matters")}<p style="margin: 0; color: ${PRIMARY_TEXT}; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 24px;">${escapeHtml(analysis.whyItMatters)}</p></td></tr>
                  <tr><td style="padding: 22px 0; border-top: 1px solid #26344d;">${sectionLabel("What you can learn")}<p style="margin: 0; color: ${PRIMARY_TEXT}; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 24px;">${escapeHtml(analysis.educationalValue)}</p></td></tr>
                  <tr><td style="padding: 22px 0; border-top: 1px solid #26344d;">${sectionLabel("Project ideas")}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; overflow: hidden; border: 1px solid #2a3954; border-radius: 10px; background-color: ${PANEL_BACKGROUND};">${projectIdeaRows(analysis.projectOpportunities)}</table></td></tr>
                  <tr><td style="padding: 22px 0; border-top: 1px solid #26344d;">${sectionLabel("Technologies")}<div>${technologyBadges(analysis.technologies)}</div></td></tr>
                  <tr><td style="padding: 22px 0 0; border-top: 1px solid #26344d;">${sectionLabel("Original source")}<p style="margin: 0 0 16px; color: ${PRIMARY_TEXT}; font-family: Arial, Helvetica, sans-serif; font-size: 16px; font-weight: 700; line-height: 24px;">${escapeHtml(analysis.sourceTitle)}</p><a href="${escapedHref}" style="display: inline-block; padding: 11px 16px; border-radius: 8px; background-color: ${ACCENT}; color: #07111f; font-family: Arial, Helvetica, sans-serif; font-size: 15px; font-weight: 700; line-height: 20px; text-decoration: none;">View original source &#8594;</a><p style="margin: 14px 0 0; color: ${SECONDARY_TEXT}; font-family: Arial, Helvetica, sans-serif; font-size: 13px; line-height: 19px; overflow-wrap: anywhere; word-break: break-word;">${escapedSourceUrl}</p></td></tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding: 18px 30px; border-top: 1px solid #26344d; background-color: #0d1422;">
                <p style="margin: 0; color: ${SECONDARY_TEXT}; font-family: Arial, Helvetica, sans-serif; font-size: 13px; line-height: 19px;">AI Agent Radar<br>Automated AI discovery monitor</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
  };
}
