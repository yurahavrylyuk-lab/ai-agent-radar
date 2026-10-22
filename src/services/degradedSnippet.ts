const MAX_INPUT_BYTES = 8192;
const MAX_OUTPUT_BYTES = 768;

function codePointBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const next = codePointBytes(character.codePointAt(0) ?? 0);
    if (bytes + next > maximumBytes) break;
    result += character;
    bytes += next;
  }
  return result;
}

function isAsciiLetter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z]/.test(value);
}

function tagStart(value: string, offset: number): boolean {
  let cursor = offset + 1;
  if (value[cursor] === "/") cursor += 1;
  return isAsciiLetter(value[cursor]) || value[cursor] === "!" || value[cursor] === "?";
}

function findTagEnd(value: string, offset: number): number {
  let quote: "'" | '"' | undefined;
  for (let cursor = offset + 1; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === ">") return cursor;
  }
  return -1;
}

function tagIdentity(tag: string): { closing: boolean; name: string } | undefined {
  const match = /^\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(tag);
  if (!match) return undefined;
  return { closing: match[1] === "/", name: match[2].toLowerCase() };
}

function stripMarkup(value: string): string {
  let result = "";
  let suppressed: "script" | "style" | undefined;
  for (let cursor = 0; cursor < value.length;) {
    if (value[cursor] !== "<" || !tagStart(value, cursor)) {
      if (!suppressed) result += value[cursor];
      cursor += 1;
      continue;
    }

    const end = findTagEnd(value, cursor);
    if (end < 0) break;
    const identity = tagIdentity(value.slice(cursor + 1, end));

    if (suppressed) {
      if (identity?.closing && identity.name === suppressed) {
        suppressed = undefined;
        result += " ";
      }
    } else if (identity && !identity.closing && (identity.name === "script" || identity.name === "style")) {
      suppressed = identity.name;
      result += " ";
    } else {
      result += " ";
    }
    cursor = end + 1;
  }
  return result;
}

const ENTITY_VALUES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeApprovedEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, entity => ENTITY_VALUES[entity] ?? entity);
}

/** Produces bounded plain text for degraded digest cards; the caller still owns HTML escaping. */
export function cleanDegradedSnippet(input: string | undefined): string {
  if (!input) return "";
  const bounded = truncateUtf8(input, MAX_INPUT_BYTES);
  const withoutRawMarkup = stripMarkup(bounded);
  const decodedOnce = decodeApprovedEntities(withoutRawMarkup);
  const withoutDecodedMarkup = stripMarkup(decodedOnce);
  const normalized = withoutDecodedMarkup
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateUtf8(normalized, MAX_OUTPUT_BYTES).trimEnd();
}
