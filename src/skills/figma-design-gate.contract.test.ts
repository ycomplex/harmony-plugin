import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';
import { defaultFigmaConnectionReader, resolveFigmaRoute, figmaBehavioursEnabled } from '../tools/figma-connection.js';
import { MCP_CALL_CAP } from '../tools/figma-composition.js';

// B-1203 — the Figma design gate. Three behaviours (visual-handoff Figma path, clarify sketch item,
// design-decide product-track check) are ALL gated on the same connection preflight and INERT when unconnected.

const REGISTERED = new Set(registerTools().map((t) => t.name));
const clarify = readSkill('harmony-clarify').body;
const design = readSkill('harmony-design-decide').body;
const handoff = readSkill('harmony-visual-handoff').body;

function section(body: string, startMarker: string, endMarker: string): string {
  const a = body.indexOf(startMarker);
  expect(a, `missing ${startMarker}`).toBeGreaterThanOrEqual(0);
  const b = body.indexOf(endMarker, a + startMarker.length);
  expect(b, `missing ${endMarker}`).toBeGreaterThan(a);
  return body.slice(a, b);
}

const clarifyItem = section(clarify, '**Flow-sketch validate item (B-1203)', '**Phase-split detection');
const designCheck = section(design, '**Product-track coverage check (B-1203)', '### 1c.');
const figmaPath = section(handoff, '### 3c. Figma path (B-1203)', '### 4. Iterate');

describe('B-1203 preflight is inert today', () => {
  it('the default reader resolves unconnected, so every Figma-gated behaviour is off', async () => {
    const route = resolveFigmaRoute(await defaultFigmaConnectionReader.read());
    expect(route).toBe('html');
    expect(figmaBehavioursEnabled(route)).toBe(false);
  });
});

describe('visual-handoff: routing (three outcomes)', () => {
  it('names unconnected->html, connected->figma, failing->stop with no silent fallback', () => {
    expect(figmaPath).toMatch(/unconnected\s*→\s*`html`[\s\S]*unchanged/);
    expect(figmaPath).toMatch(/connected\s*→\s*`figma`/);
    expect(figmaPath).toMatch(/failing\s*→\s*`stop`[\s\S]*reconnect/);
    expect(figmaPath).toMatch(/Never silently fall back/);
  });
  it('keeps the generated-HTML path and glanceable/flow routing intact', () => {
    expect(handoff).toContain('### 3a. Generate the surface (default path)');
    expect(figmaPath).toMatch(/glanceable-vs-flow routing \(step 2\) unchanged/);
  });
  it('is absent when unconnected: the Figma path only runs on the figma route, html runs 3a', () => {
    expect(figmaPath).toMatch(/Until B-1201 lands the preflight resolves to\s+`html`, so this step does not run/);
  });
});

describe('visual-handoff: the artefact write', () => {
  it('composes from library instances, not imported layers; one use_figma call, one to fix', () => {
    expect(figmaPath).toMatch(/library instances\*\*\s*\(not imported layers\)/);
    expect(figmaPath).toMatch(/`use_figma`\s+\*\*once\*\*/);
    expect(figmaPath).toMatch(/`<ticket> · <option>`/);
    expect(figmaPath).toMatch(/provenance[\s\S]*real[\s\S]*invented[\s\S]*illustrative[\s\S]*frame notes/);
  });
  it('renders over REST /v1/images pinned to the file version', () => {
    expect(figmaPath).toContain('GET /v1/images');
    expect(figmaPath).toMatch(/pinned to the\s+file version/);
    expect(figmaPath).toMatch(/not `get_screenshot`/);
  });
  it('records the MCP call count with a hard cap of 6 (typical 2-3), through the shared limiter', () => {
    expect(MCP_CALL_CAP).toBe(6);
    expect(figmaPath).toMatch(/hard cap 6 per leg\*\*\s*\(typical 2-3\)/);
    expect(figmaPath).toContain('mcp_call_count');
    expect(figmaPath).toMatch(/shared limiter/);
    expect(figmaPath).toMatch(/say so on the brief/);
  });
  it('treats a scaffold/inception sketch as reference only, flows as ordered captioned frames', () => {
    expect(figmaPath).toMatch(/reference only/);
    expect(figmaPath).toMatch(/re-composed from library instances/);
    expect(figmaPath).toMatch(/N frames in order with a caption each/);
  });
  it('names B-1201 / B-1202 as dependencies, not assumptions', () => {
    expect(figmaPath).toMatch(/B-1201/);
    expect(figmaPath).toMatch(/B-1202/);
    expect(figmaPath).toContain('`design_artefact` (schema_version 1)');
    expect(figmaPath).toMatch(/recompose the design brief with it as `frame\.design_artefact`/);
    expect(figmaPath).toMatch(/refuses with the promote prerequisite/);
    for (const f of ['composed_at', 'provenance_notes', 'preview_attachment_id', 'preview_filename', 'file_key', 'file_url', 'version_id']) {
      expect(figmaPath).toContain(f);
    }
    expect(figmaPath).toMatch(/no signed URLs/);
  });
});

describe('clarify: flow-sketch validate item', () => {
  it('is UI-heavy only, never by default, and gated on the figma route', () => {
    expect(clarifyItem).toContain('would a flow sketch settle this?');
    expect(clarifyItem).toMatch(/UI-heavy/);
    expect(clarifyItem).toMatch(/never asked on a\s+non-UI ticket and never by default/);
    expect(clarifyItem).toMatch(/only when the Figma connection preflight\s+resolves to `figma`/);
  });
  it('is absent when unconnected/failing: clarify behaves exactly as before', () => {
    expect(clarifyItem).toMatch(/resolves to `html`, `stop`, or cannot be read, the item\s+does not exist/);
    expect(clarifyItem).toMatch(/exactly as before/);
  });
  it('composes via the Figma path BEFORE the brief and records doc.frame.sketch', () => {
    expect(clarifyItem).toMatch(/BEFORE the clarification brief composes/);
    expect(clarifyItem).toContain('doc.frame.sketch');
  });
});

describe('design-decide: product-track coverage check', () => {
  it('runs only on the figma route and is absent (track proposal as today) when unconnected', () => {
    expect(designCheck).toMatch(/only when the Figma\s+connection preflight resolves to `figma`/);
    expect(designCheck).toMatch(/does not run and the track proposal above is exactly as it always was/);
  });
  it('reads the sketch and answered questions; all covered => not-required naming answers/frames', () => {
    expect(designCheck).toContain('get_elicitation');
    expect(designCheck).toMatch(/clarify slot's `sketch`/);
    expect(designCheck).toMatch(/`not-required`, with a note naming the answers and frames/);
    expect(referencedHarmonyTools(design)).toContain('get_elicitation');
  });
  it('uncovered => residual only with "Already answered, not re-asked"; sketch reused, never recomposed', () => {
    expect(designCheck).toMatch(/residual only/);
    expect(designCheck).toContain('Already answered, not re-asked');
    expect(designCheck).toMatch(/reused, never recomposed/);
  });
});

describe('visual-handoff: composition pins its own previews (B-1203)', () => {
  it('ends the compose script with a settle wait and figma.saveVersionHistoryAsync, in the same call', () => {
    expect(figmaPath).toContain('figma.saveVersionHistoryAsync');
    expect(figmaPath).toMatch(/settle\s+wait/);
    expect(figmaPath).toMatch(/inside the same call\*\*\s*\(no extra MCP call\)/);
  });
  it('pins to the returned version id and does not wait on autosave', () => {
    expect(figmaPath).toMatch(/Pin to that \*\*returned version\s+id\*\*/);
    expect(figmaPath).toMatch(/version=<that id>/);
    expect(figmaPath).toMatch(/autosave wait[\s\S]*is \*\*retired\*\*/);
    expect(figmaPath).toMatch(/do\s+not wait on autosave/);
  });
  it('checks every frame present and every image non-null, else the honest no-preview note, never failing the gate', () => {
    expect(figmaPath).toContain('checkPreviewSet');
    expect(figmaPath).toMatch(/every planned frame is in the\s+saved version's `frameIds` and every image URL is non-null/);
    expect(figmaPath).toContain('NO_PREVIEW_NOTE');
    expect(figmaPath).toMatch(/never a\s+partial set/);
    expect(figmaPath).toMatch(/do \*\*not\*\* fail the gate/);
  });
  it('applies to a clarify sketch and leaves the gating untouched', () => {
    expect(figmaPath).toMatch(/same applies to a\s+clarify sketch: its `frame\.sketch` `pinned_version`/);
    expect(figmaPath).toMatch(/unconnected\s*→\s*`html`[\s\S]*unchanged/);
    expect(figmaPath).toMatch(/hard cap 6 per leg/);
  });
});

describe('visual-handoff: throttling (429)', () => {
  it('backs off per Retry-After, never retries immediately, asks the operator when exhausted, no silent HTML fallback', () => {
    expect(figmaPath).toMatch(/Throttled \(HTTP 429\)/);
    expect(figmaPath).toMatch(/`Retry-After`/);
    expect(figmaPath).toMatch(/exponential backoff/);
    expect(figmaPath).toMatch(/never immediate/);
    expect(figmaPath).toMatch(/start_elicitation[\s\S]*worker-question[\s\S]*designing/);
    expect(figmaPath).toContain('file_elicitation_round');
    expect(figmaPath).toMatch(/do \*\*not\*\* fail the gate and do \*\*not\*\* fall back to the HTML path silently/);
  });
});

describe('every referenced tool is real', () => {
  it('references only registered MCP tools', () => {
    for (const body of [clarify, design, handoff]) {
      for (const t of referencedHarmonyTools(body)) expect(REGISTERED.has(t), t).toBe(true);
    }
  });
});
