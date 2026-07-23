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
