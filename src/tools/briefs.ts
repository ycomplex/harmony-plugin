// P3: Brief substrate + command set (gate-ui-conductor §3, §4). The structured doc is canonical; the
// Markdown blob is DERIVED by renderBrief(). The §3.2 disciplines are a mechanical lint over the same
// canonical doc — so what's checked is exactly what's rendered.

export interface BriefItem {
  /** §3.2 sort: a decision (always recommended), a content-input (only the human can supply it),
   *  or a derived-constraint (already fixed elsewhere — belongs in Context, never an ask). */
  kind: 'decision' | 'content-input' | 'derived-constraint';
  text: string;
  recommendation?: string;
  /** true when the decision is deferred behind research (the load-bearing-gap path). */
  deferred?: boolean;
}

export interface BriefAlternative {
  option: string;
  rejection: string;
}

/** The canonical structured brief (the BLUF skeleton as data). renderBrief() is its only renderer. */
export interface BriefDoc {
  decide: string;
  recommend?: { text: string; confidence?: 'low'; cede?: boolean };
  why?: string[];
  alternatives?: BriefAlternative[];
  context?: string[];
  items: BriefItem[];
  research?: string[];
  load_bearing_gap?: boolean;
  tail?: string;
}

export interface BriefLintResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const WORD_BUDGET = 300; // §3.2 soft budget (~250–300)
const DEFAULT_TAIL = 'Type `accept`, `edit`, `iterate <feedback>`, or `defer`.';

/** Render the canonical doc to the §3.1 BLUF Markdown blob, deterministically. */
export function renderBrief(doc: BriefDoc): string {
  const out: string[] = [];
  out.push(`## DECIDE: ${doc.decide}`, '');

  if (doc.load_bearing_gap) {
    // Research-first (§3.2): open with the research, defer the substantive recommendation — never buried.
    out.push("**Recommend:** I don't know enough yet — run the research below before deciding.", '');
    out.push('**Research first:**');
    (doc.research ?? []).forEach((p, i) => out.push(`${i + 1}. ${p}`));
    out.push('');
  } else if (doc.recommend) {
    let suffix = '';
    if (doc.recommend.cede) suffix = ' (low confidence — this is a values call you should own)';
    else if (doc.recommend.confidence === 'low') suffix = ' (low confidence — see below)';
    out.push(`**Recommend${suffix}:** ${doc.recommend.text}`, '');
  }

  if (doc.why?.length) {
    out.push('**Why:**', ...doc.why.map((w) => `- ${w}`), '');
  }
  if (doc.alternatives?.length) {
    out.push('**Alternatives:**', ...doc.alternatives.map((a) => `- ${a.option} — ${a.rejection}`), '');
  }
  if (doc.context?.length) {
    out.push('**Context:**', ...doc.context.map((c) => `- ${c}`), '');
  }

  if (doc.items.length) {
    out.push('**You need to:**');
    for (const item of doc.items) {
      if (item.kind === 'content-input') {
        out.push(`- [ ] ${item.text} *(your input needed)*`);
      } else if (item.kind === 'decision') {
        const rec = !item.deferred && item.recommendation ? ` — *recommend: ${item.recommendation}*` : '';
        out.push(`- [ ] ${item.text}${rec}`);
      }
      // derived-constraint items never render — the lint rejects them before this point.
    }
    out.push('');
  }

  out.push(`> ${doc.tail ?? DEFAULT_TAIL}`);
  return out.join('\n');
}

/** Enforce the §3.2 disciplines on the canonical doc. `content` is the rendered blob (for the word budget). */
export function lintBrief(doc: BriefDoc, content: string): BriefLintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const research = doc.research ?? [];

  for (const item of doc.items) {
    // Rule 2 (the single most-repeated failure, B-320/B-327): a derived constraint already fixed
    // elsewhere is Context, never a "confirm" — forcing the human to confirm it wastes a decision.
    if (item.kind === 'derived-constraint') {
      errors.push(
        `Item "${item.text}" is a derived constraint already fixed elsewhere — move it to Context, do not ask the human to confirm it.`,
      );
      continue;
    }
    // Rule 1 (no naked forks): every decision carries a recommendation, unless deferred behind research.
    if (item.kind === 'decision' && !item.deferred && !item.recommendation?.trim()) {
      errors.push(
        `Decision "${item.text}" has no recommendation (naked fork). Recommend a default (mark it cede-able if it's a values call), or defer it behind research.`,
      );
    }
  }

  // Rule 3 (research-first when load-bearing, B-327): lead with the research, never bury it; and don't
  // ask a substantive decision the agent is out of depth on — defer it until research returns.
  if (doc.load_bearing_gap) {
    if (research.length === 0) {
      errors.push('Load-bearing knowledge gap declared but no research supplied — lead with the research, do not guess.');
    }
    if (doc.items.some((i) => i.kind === 'decision' && !i.deferred)) {
      errors.push('Load-bearing gap declared but a substantive decision is still being asked — defer the recommendation until research returns.');
    }
  }

  // Soft: word budget (§3.2 — soft, not enforced: trim noise, don't amputate reasoning).
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  if (words > WORD_BUDGET) {
    warnings.push(
      `Brief renders to ${words} words (soft budget ${WORD_BUDGET}). Trim noise — but don't amputate reasoning; expose detail via expand instead.`,
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}
