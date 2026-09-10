// ---------------------------------------------------------------------------
// Helper: normalizeHtmlEntities (B-976)
// ---------------------------------------------------------------------------
//
// Write-layer text hygiene: decode exactly 5 named HTML entities that show up
// as transcription artifacts in tool-layer title/description/content writes
// (e.g. a client that HTML-escapes before sending, or a copy/paste through an
// HTML-aware surface). Scope is deliberately narrow -- only these 5 entities,
// nothing else (no numeric entities, no full HTML-entity table).
//
// Fenced (three-backtick-fenced) and inline (single-backtick) code spans are
// left byte-identical: text inside a code span is verbatim source/output the
// user is quoting, and decoding entities there would corrupt it (e.g. a code
// sample that itself contains a literal ampersand-entity).
//
// This is a three-state rule, all by design:
//   1. An intentional literal OUTSIDE a code span (e.g. someone writes the
//      literal entity text in prose, not inside code) IS normalized. This
//      is accepted residual behavior, not a bug -- the write layer cannot
//      distinguish "mangled" from "deliberately typed" outside of code
//      context, and code context is the one place we know verbatim intent.
//   2. Code-quoted (inside fenced or inline code) -> left untouched.
//   3. Genuinely-mangled (a real transcription artifact) -> normalized. This
//      is the actual defect this ticket fixes.
//
// Field set (per the accepted design): task title+description, comment
// content, knowledge entry title+content, acceptance-criteria content,
// test-case names, checklist-item titles, and entity name+description
// (B-993 -- the latter via createEntity and the shared resolveOrCreateEntity
// helper used by record_decision/assert_fact/link_ticket_entities).

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

const ENTITY_PATTERN = /&amp;|&lt;|&gt;|&quot;|&#39;/g;
// Separate non-global pattern for the cheap early-exit check below, so we never share
// mutable lastIndex state between a .test() guard and the .replace() calls that do the
// real work.
const HAS_ENTITY_PATTERN = /&amp;|&lt;|&gt;|&quot;|&#39;/;

// Splits `text` into alternating non-code / code segments. Code segments are
// fenced blocks (```...```, including a dangling unterminated fence -- treated
// as code through end-of-string, never decoded) and inline spans (`...`).
// We scan left-to-right rather than using one alternation regex so fenced
// blocks take priority over inline backticks that might appear inside them.
function splitCodeSpans(text: string): Array<{ code: boolean; text: string }> {
  const segments: Array<{ code: boolean; text: string }> = [];
  let i = 0;
  let plainStart = 0;

  while (i < text.length) {
    if (text.startsWith('```', i)) {
      const close = text.indexOf('```', i + 3);
      const codeEnd = close === -1 ? text.length : close + 3;
      if (plainStart < i) segments.push({ code: false, text: text.slice(plainStart, i) });
      segments.push({ code: true, text: text.slice(i, codeEnd) });
      i = codeEnd;
      plainStart = i;
      continue;
    }
    if (text[i] === '`') {
      const close = text.indexOf('`', i + 1);
      if (close === -1) {
        // No closing backtick anywhere -- not a real span, leave the lone
        // backtick as ordinary text and move past it.
        i += 1;
        continue;
      }
      if (plainStart < i) segments.push({ code: false, text: text.slice(plainStart, i) });
      segments.push({ code: true, text: text.slice(i, close + 1) });
      i = close + 1;
      plainStart = i;
      continue;
    }
    i += 1;
  }
  if (plainStart < text.length) segments.push({ code: false, text: text.slice(plainStart) });
  return segments;
}

/**
 * Decode the 5 named HTML entities (ampersand, less-than, greater-than, quote,
 * apostrophe entities) in `text`, skipping fenced and inline code spans, which
 * are left byte-identical.
 */
export function normalizeHtmlEntities(text: string): string {
  if (!text || !HAS_ENTITY_PATTERN.test(text)) return text;

  return splitCodeSpans(text)
    .map(seg =>
      seg.code ? seg.text : seg.text.replace(ENTITY_PATTERN, m => ENTITY_MAP[m] ?? m),
    )
    .join('');
}
