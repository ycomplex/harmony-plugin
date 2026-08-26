// B-743: coverage for the Run Options extensibility contract doc (AC7) — guards against silent
// bit-rot on the file list a later control (B-772, B-773, ...) is told to follow.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const DOC_PATH = join(process.cwd(), 'skills', 'harmony-conduct', 'run-options-extensibility.md');

describe('Run Options extensibility contract doc', () => {
  const body = readFileSync(DOC_PATH, 'utf8');

  it('names every plugin-side seam file a new control touches', () => {
    expect(body).toContain('src/config/run-config.ts');
    expect(body).toContain('src/tools/conduction-record.ts');
    expect(body).toMatch(/create_conduction.*MCP tool/is);
    expect(body).toContain('src/daemon/scheduler.ts');
    expect(body).toContain('src/tools/environment.ts');
    expect(body).toContain('skills/harmony-conduct/SKILL.md');
  });

  it('names the web-side seam files a new control touches', () => {
    expect(body).toContain('web/src/features/workflow/hooks/useCreateConduction.ts');
    expect(body).toContain('web/src/features/workflow/components/WorkflowPrimaryAction.tsx');
  });

  it('explicitly names B-772 (which model runs a gate) and B-773 (which gates auto-approve) as the first two consumers', () => {
    expect(body).toMatch(/B-772/);
    expect(body).toMatch(/B-773/);
    expect(body).toMatch(/B-772[\s\S]{0,80}model/i);
    expect(body).toMatch(/B-773[\s\S]{0,80}auto-approve/i);
  });

  it('explains WHY a skill-consumed control needs the environment.ts seam (no Bash in harmony-conduct)', () => {
    expect(body).toMatch(/allowed-tools/);
    expect(body).toMatch(/no `?Bash`?/i);
  });
});
