import { describe, it, expect, vi } from 'vitest';
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
    vi.stubEnv('HARMONY_FIGMA_CONTEXT_B64', '');
    const route = resolveFigmaRoute(await defaultFigmaConnectionReader.read());
    vi.unstubAllEnvs();
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
  it('renders over REST /v1/images from the live file, with no version parameter', () => {
    expect(figmaPath).toContain('GET /v1/images');
    expect(figmaPath).toMatch(/GET \/v1\/images\?ids=…&format=png`\s+with \*\*no `version` parameter\*\*/);
    expect(figmaPath).toMatch(/not\s+`get_screenshot`/);
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

describe('visual-handoff: previews render from the live file (B-1203)', () => {
  it('has no save tail: the compose script returns frameIds and saves no version', () => {
    expect(figmaPath).toMatch(/returns `\{ frameIds \}`[\s\S]*saves no version/);
    expect(figmaPath).toMatch(/refuses `figma\.saveVersionHistoryAsync`/);
    expect(figmaPath).toMatch(/no\s+save tail/);
    expect(figmaPath).not.toMatch(/ends by saving a Figma version/);
    expect(figmaPath).not.toMatch(/saveVersionTail/);
    expect(figmaPath).toMatch(/never waits on autosave/);
  });
  it('checks every frame in the compose result and every image non-null, else the honest no-preview note, never failing the gate', () => {
    expect(figmaPath).toContain('checkPreviewSet');
    expect(figmaPath).toMatch(/every planned frame is in the\s+compose call's returned `frameIds` and every image URL is non-null/);
    expect(figmaPath).toContain('NO_PREVIEW_NOTE');
    expect(figmaPath).toMatch(/never a\s+partial set/);
    expect(figmaPath).toMatch(/do \*\*not\*\* fail the gate/);
  });
  it('writes a versionless record only when the board reports version_optional, else says plainly no record was stored', () => {
    expect(figmaPath).toMatch(/optional since B-1203/);
    expect(figmaPath).toMatch(/ONLY when the board reports `version_optional: true`/);
    expect(figmaPath).toContain('VersionOptionalUnsupportedError');
    expect(figmaPath).toMatch(/say plainly on the brief that no design\s+record was stored/);
    expect(figmaPath).toMatch(/never a silent miss/);
  });
  it('asks an operator who wants to edit to save a version under the exact suggested name', () => {
    expect(figmaPath).toContain('suggestedVersionName');
    expect(figmaPath).toContain('Before · <ticket> · round <brief iteration>');
  });
  it('applies to a clarify sketch and leaves the gating untouched', () => {
    expect(figmaPath).toMatch(/A clarify sketch\s+composes the same way/);
    expect(figmaPath).toMatch(/unconnected\s*→\s*`html`[\s\S]*unchanged/);
    expect(figmaPath).toMatch(/hard cap 6 per leg/);
  });
  it('reconciles a versionless record by exact name and never reports no changes on an unknown baseline', () => {
    const i = handoff.indexOf("### 3d. Reconcile a designer's edits (B-1204)");
    const seg = handoff.slice(i, handoff.indexOf('### 4. Iterate', i));
    expect(seg).toContain('findVersionByLabel');
    expect(seg).toMatch(/\*\*exactly\*\*\s+equals that name/);
    expect(seg).toContain('named-version-missing');
    expect(seg).toContain('I can\'t see a version named "<name>".');
    expect(seg).toMatch(/possible\s+change — please\s+confirm/);
    expect(seg).toMatch(/never as "no changes"/);
    expect(seg).toContain('harmony design fingerprint take');
    expect(seg).toContain('harmony design fingerprint compare');
  });
});

describe('design-decide and start-work: the content fingerprint (B-1203)', () => {
  const startWork = readSkill('start-work').body;
  it('design-decide takes the fingerprint after the design accept is consumed, and a failure never blocks', () => {
    const i = design.indexOf('**Fingerprint the accepted Figma design (B-1203).**');
    expect(i).toBeGreaterThan(design.indexOf('behavior is unchanged by B-1034.') - 1);
    const seg = design.slice(i, i + 1400);
    expect(seg).toContain('design fingerprint take --task <ticket>');
    expect(seg).toMatch(/figma\*\* `design_artefact`/);
    expect(seg).toMatch(/`not-taken`/);
    expect(seg).toMatch(/never\s+blocks/);
  });
  it('start-work compares at the plan gate and at the build gate, and a changed fingerprint stops the build', () => {
    expect(startWork).toContain('design fingerprint compare --task <ticket> --by plan');
    expect(startWork).toContain('design fingerprint compare --task <ticket> --by build');
    expect(startWork).toMatch(/Drift `changed` stops the build/);
    expect(startWork).toMatch(/unless a plan step names/);
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

describe('B-1320 adopt a designer\'s frames', () => {
  it('visual-handoff 3c opens with the adopt block, before the numbered list', () => {
    const adopt = figmaPath.indexOf('**Adopt first (B-1320).**');
    expect(adopt).toBeGreaterThan(0);
    expect(adopt).toBeLessThan(figmaPath.indexOf('\n1. Keep the glanceable-vs-flow routing'));
    const block = figmaPath.slice(adopt, figmaPath.indexOf('Figma path (planner:'));
    expect(block).toContain('design adopt-check --task <ticket>');
    expect(block).toMatch(/compose \*\*no options\*\*/);
    expect(block).toContain('Adopt these\nframes as drawn?');
    expect(block).toMatch(/`human-in-tool`, `mcp_call_count` 0/);
    expect(block).toMatch(/adopted \/ off-library \/ not covering the decision/);
    expect(block).toMatch(/`not-checked` frame is never adopted/);
    expect(block).toMatch(/Never modify the designer's frames or pages/);
  });
  it('B-1338: the check reads the saved library map, never a Figma component lookup; every judged frame is shown', () => {
    const adopt = figmaPath.indexOf('**Adopt first (B-1320).**');
    const block = figmaPath.slice(adopt, figmaPath.indexOf('Figma path (planner:'));
    expect(block).toMatch(/reads the workspace's saved library map and its ambiguous-name candidates, never a Figma component\s+lookup/);
    expect(block).not.toMatch(/asks? Figma (which file|per component)/i);
    expect(block).toMatch(/A name-only match is off-library \("drawn from another copy of the library"\)/);
    expect(block).toMatch(/For EVERY frame given a verdict, adopted or not, attach its\s+live REST preview/);
    expect(block).toContain('`frame.designer_frames`');
    expect(block).toMatch(/inline above the decision/);
    expect(block).toContain('--url <figma-link>');
  });
  it('item 9 separates the scaffold (reference) from the designer\'s frames (adopted)', () => {
    expect(figmaPath).toMatch(/9\. A Claude Design scaffold or an inception sketch is \*\*reference only\*\*[\s\S]*designer's own library-built Figma frames are \*\*adopted\*\*/);
  });
  it('keeps the saved-component-map step and the section anchors', () => {
    expect(figmaPath).toContain('2. Read the **saved component map**; do no per-leg library search.');
    expect(handoff).toContain('### 3c. Figma path (B-1203) — selected by the connection preflight');
    expect(handoff).toContain('### 4. Iterate');
  });
  it('clarify stands the flow-sketch item down when a designer\'s design is linked', () => {
    expect(clarifyItem).toContain('design adopt-check --task <ticket> --links-only');
    expect(clarifyItem).toMatch(/does not exist when a designer's\s+design is already attached/);
    expect(clarifyItem).toMatch(/as if the preflight\s+resolved to `html` for this item/);
  });
});

describe('B-1320: a linked designer frame always gets the UX/UI track', () => {
  it('design-decide requires UX/UI when adopt-check --links-only reports a readable frame link', () => {
    expect(design).toContain('A linked designer frame always gets the UX/UI track (B-1320)');
    expect(design).toContain('design adopt-check --task <ticket> --links-only');
    expect(design).toMatch(/Never mark UX\/UI `not-required` while such a frame is unjudged/);
  });
});

describe('B-1325: per-project Figma working file', () => {
  const wf = section(handoff, '#### Working file (B-1325)', 'Figma path (planner:');
  it('visual-handoff resolves the working file, composes only there, never the library', () => {
    expect(wf).toContain('working-file resolve');
    expect(wf).toMatch(/`ready`/);
    expect(wf).toMatch(/`refuse`/);
    expect(wf).toMatch(/`ask`/);
    expect(wf).toMatch(/never the library/);
    expect(wf).toMatch(/Never create a file, never choose one yourself/);
    expect(wf).toContain('<visual id> · ');
    expect(wf).toContain('setCurrentPageAsync');
  });
  it('save is called only after an answered round and always records the exchange id', () => {
    expect(wf).toContain('working-file validate');
    expect(wf).toMatch(/working-file save --file <key> --task <ticket> --exchange <exchange id>/);
    expect(wf).toMatch(/only after an answered round/);
    expect(wf).toMatch(/always records the exchange id/);
  });
  it('degradations and the marker comment', () => {
    expect(wf).toContain('FIGMA-WORKING-FILE-SET');
    expect(wf).toContain('rpc-absent');
    expect(wf).toContain('not-owner');
    expect(wf).toMatch(/THIS LEG ONLY/);
    expect(wf).toMatch(/Design tool panel/);
  });
  it('reads of earlier designs keep the record file_key; step 3 composes only in the working file', () => {
    expect(wf).toMatch(/stored on that design record/);
    expect(figmaPath).toMatch(/working file/);
  });
  it('clarify and design-decide point at the working file rule', () => {
    expect(clarifyItem).toContain('working-file resolve');
    expect(clarifyItem).toMatch(/never write to the library file/);
    expect(design).toContain('Working file (B-1325)');
    expect(designCheck).toContain('Working file (B-1325)');
  });
});
