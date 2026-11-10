// B-1435: the remote-conductor manifests and the two Cloud Build files ship to every adopter, so they must carry no
// value that identifies Harmony's own deployment. Each deployment value is a __NAME__ placeholder the runbook lists
// (docs/remote-conductor-runbook.md step 4), or is derived at run time (Cloud Build's ${PROJECT_ID}). Product-wide
// defaults that cannot by themselves point at anyone's resources (secret names, harmony-legs, the _REGION default)
// are allowed.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const MANIFESTS = [
  'container/conductor/k8s/configmap.yaml',
  'container/conductor/k8s/deployment.yaml',
  'container/conductor/k8s/serviceaccount.yaml',
  'container/conductor/k8s/cronjob-sweep.yaml',
];
const BUILD_FILES = ['container/conductor/cloudbuild.yaml', 'container/cloudbuild.yaml'];

// Each pattern names one way Harmony's own deployment used to leak into a shipped file.
const FORBIDDEN: Array<[string, RegExp]> = [
  ['the conductor service-account email', /harmony-conductor@/],
  ['harmony-conductor as a registry path segment (the GCP project)', /\/harmony-conductor\//],
  ['the registry in project harmony-conductor', /docker\.pkg\.dev\/harmony-conductor/],
  ["Harmony's model policy", /claude-sonnet/],
  ['the legacy Codex login secret name', /harmony-codex-auth/],
];

// The one allowed us-central1: the build files' overridable `_REGION` default.
const ALLOWED_REGION_LINE = /^\s*_REGION: us-central1\s*$/;

describe('shipped deploy files carry no Harmony deployment value (B-1435)', () => {
  it.each([...MANIFESTS, ...BUILD_FILES])('%s', (file) => {
    const text = read(file);
    for (const [what, pattern] of FORBIDDEN) {
      expect(text, `${file} contains ${what}`).not.toMatch(pattern);
    }
    const regionLines = text.split('\n').filter((line) => line.includes('us-central1') && !ALLOWED_REGION_LINE.test(line));
    expect(regionLines, `${file} names us-central1 outside the _REGION default`).toEqual([]);
  });

  it('every __NAME__ placeholder in the manifests is listed in the runbook step 4', () => {
    const runbook = read('docs/remote-conductor-runbook.md');
    const start = runbook.indexOf('## 4. ');
    const end = runbook.indexOf('## 5. ', start);
    expect(start).toBeGreaterThan(-1);
    const step4 = runbook.slice(start, end);

    const placeholders = new Set(MANIFESTS.flatMap((f) => read(f).match(/__[A-Z][A-Z0-9_]*__/g) ?? []));
    placeholders.delete('__NAME__'); // the header comments' generic name for them
    expect(placeholders.size).toBeGreaterThan(0);
    for (const p of placeholders) expect(step4, `runbook step 4 does not mention ${p}`).toContain(p);
  });
});
