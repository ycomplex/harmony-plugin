// B-696 cross-file drift guard: the shipped launch-profile template must speak the container
// ENTRYPOINT's mode contract. provision.sh dispatches on its FIRST argument (`shell | headless
// <prompt>`), so the token right after the image name in the launch template MUST be one of
// provision.sh's real modes — the original template passed `claude` there, which provision.sh
// rejects as an unknown mode. Both files are read from disk so either side drifting breaks CI.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const profilePath = fileURLToPath(
  new URL('../../container/daemon-profile.example.json', import.meta.url),
);
const provisionPath = fileURLToPath(new URL('../../container/provision.sh', import.meta.url));

const IMAGE_NAME = 'harmony-build-env';

/** The token the container ENTRYPOINT receives as its first argument: the word immediately
 *  following the image name in the docker run command line. */
function modeTokenAfterImage(launch: string): string | undefined {
  const words = launch.split(/\s+/);
  const imageIndex = words.indexOf(IMAGE_NAME);
  expect(imageIndex).toBeGreaterThanOrEqual(0); // the template must still launch the known image
  return words[imageIndex + 1];
}

/** provision.sh's REAL modes: the literal labels of its `case "$MODE" in` dispatch. */
function provisionModes(script: string): string[] {
  const caseBlock = /case\s+"\$MODE"\s+in\n([\s\S]*?)\nesac/.exec(script);
  if (!caseBlock) return [];
  const modes: string[] = [];
  for (const line of caseBlock[1].split('\n')) {
    const label = /^\s*([a-z][a-z0-9_-]*)\)/.exec(line);
    if (label) modes.push(label[1]);
  }
  return modes;
}

describe('daemon-profile.example.json ↔ provision.sh mode contract', () => {
  it('the launch template passes a REAL provision.sh mode as the first arg after the image name', () => {
    const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as { launch: string };
    const script = readFileSync(provisionPath, 'utf8');

    const modes = provisionModes(script);
    // Guard the guard: an empty parsed set means the extraction regex drifted off provision.sh's
    // shape — that must fail loudly, not vacuously pass.
    expect(modes.length).toBeGreaterThan(0);
    expect(modes).toContain('headless'); // the daemon's one-shot workers are headless by design

    const modeToken = modeTokenAfterImage(profile.launch);
    expect(modes).toContain(modeToken);
  });
});

// B-724 transcript-persistence contract: the worker's Claude session logs must survive the
// container's --rm. The launch template therefore bind-mounts per-conduction host dirs over the
// worker's ~/.claude/projects and ~/.claude/logs — and must `mkdir -p` those host dirs BEFORE
// `docker run`, because Docker auto-creates missing bind sources root-owned, which the uid-1001
// worker cannot write (probe-proven at the B-724 design gate).

/** The `-v host:container` mappings of the docker run command line. */
function volumeMappings(launch: string): Array<{ host: string; container: string }> {
  const words = launch.split(/\s+/);
  const mappings: Array<{ host: string; container: string }> = [];
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i] === '-v' || words[i] === '--volume') {
      const [host, container] = words[i + 1].split(':');
      mappings.push({ host, container });
    }
  }
  return mappings;
}

describe('daemon-profile.example.json transcript-mount contract (B-724)', () => {
  const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as { launch: string };
  const mounts = volumeMappings(profile.launch);

  it('bind-mounts both Claude session-log locations (projects + logs)', () => {
    const targets = mounts.map((m) => m.container);
    expect(targets).toContain('/home/worker/.claude/projects');
    expect(targets).toContain('/home/worker/.claude/logs');
  });

  it('namespaces every transcript mount host-side by {ticket} AND {conduction_id}', () => {
    for (const m of mounts) {
      expect(m.host).toContain('{ticket}');
      expect(m.host).toContain('{conduction_id}');
    }
  });

  it('pre-creates every mounted host dir (mkdir -p …) BEFORE docker run', () => {
    const dockerRunAt = profile.launch.indexOf('docker run');
    expect(dockerRunAt).toBeGreaterThan(0);
    const preamble = profile.launch.slice(0, dockerRunAt);
    expect(preamble).toMatch(/^mkdir -p /);
    for (const m of mounts) {
      expect(preamble).toContain(m.host);
    }
  });
});

// B-724 reopen (verify-found): Docker creates mount-point PARENTS root-owned inside the
// container, so mounting under ~/.claude breaks any non-mounted sibling writer — the B-719
// declared-agent install (mkdir ~/.claude/agents) died with Permission denied on a live daemon
// leg. The image must therefore pre-create every container-side mount target (and the agents
// dir) worker-owned, so mounts land on pre-existing dirs and the parent stays writable.

const dockerfilePath = fileURLToPath(new URL('../../container/Dockerfile', import.meta.url));

describe('daemon-profile.example.json ↔ Dockerfile mount-parent ownership contract (B-724)', () => {
  const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as { launch: string };
  const dockerfile = readFileSync(dockerfilePath, 'utf8');
  const mounts = volumeMappings(profile.launch);

  it('the Dockerfile pre-creates every container-side mount target of the launch template', () => {
    expect(mounts.length).toBeGreaterThan(0); // guard the guard — no mounts means the parse drifted
    for (const m of mounts) {
      expect(dockerfile).toContain(m.container);
    }
  });

  it('the Dockerfile pre-creates the declared-agent install dir and chowns ~/.claude to worker', () => {
    expect(dockerfile).toContain('/home/worker/.claude/agents');
    expect(dockerfile).toMatch(/chown -R worker:worker \/home\/worker\/\.claude/);
  });
});
