// B-1478: the paths a worker leg and the conductor read from the plugin at run time.
//
// This is the list a trimmed release (B-1480) must keep. A path ending in `/` is a whole directory; any other path
// is one file. Paths are relative to the plugin root.
//
// TRACKED paths are in `git ls-files` on main (src/release/runtime-paths.test.ts checks every one).
// GENERATED paths exist only on the CI-generated branches (`staging`, `prod`) and in a release built from them:
// main is source-only and tracks no dist/ (CLAUDE.md, "dist/ is generated on staging"). They are listed separately
// so the tracked-tree check never pretends to cover them; the test checks instead that each is an esbuild entry
// point of `npm run build` (or the notices file its postbuild writes).
//
// Each entry names who reads it, so a reader can re-check it against the code.

export interface RuntimePath {
  path: string;
  /** Who reads it at run time. */
  readBy: string;
}

/** What a worker leg reads: container/entrypoint.sh hands off to the plugin's provision.sh, which wires the run,
 *  and the agent then runs with the plugin loaded (`--plugin-dir`, or the Codex render). */
export const WORKER_TRACKED: readonly RuntimePath[] = [
  { path: '.claude-plugin/', readBy: 'Claude Code (plugin manifest); `harmony --version`; the entrypoint version check' },
  { path: '.mcp.json', readBy: 'Claude Code: starts the MCP server (dist/index.js)' },
  { path: 'hooks/', readBy: 'Claude Code: hooks.json and its scripts (link-cli, stop-gate, pretooluse-gate, seat-session-start, seat-stop-guard)' },
  { path: 'skills/', readBy: 'the agent (Claude skills; the Codex render links them)' },
  { path: 'commands/', readBy: 'Claude Code (plugin slash commands)' },
  { path: 'CLAUDE.md', readBy: 'the agent (plugin instructions)' },
  { path: 'package.json', readBy: 'the plugin package metadata shipped with the bundle' },
  { path: 'LICENSE', readBy: 'travels with the plugin (licence)' },
  { path: 'container/provision.sh', readBy: 'container/entrypoint.sh exec' },
  { path: 'container/release-runtime', readBy: 'container/entrypoint.sh: the release marker check' },
  { path: 'container/activate-toolchain.sh', readBy: 'provision.sh (B-929)' },
  { path: 'container/install-playwright.sh', readBy: 'provision.sh (B-1184)' },
  { path: 'container/playwright-versions.py', readBy: 'container/install-playwright.sh' },
  { path: 'container/agents/harmony-build.md', readBy: 'provision.sh: copied to ~/.claude/agents (B-719)' },
  { path: 'container/git-guard/', readBy: 'provision.sh: install.sh, dirty-check.sh, the git wrapper and hooks/pre-push (B-1451)' },
  { path: 'container/codex-version', readBy: 'provision.sh: the supported Codex CLI (B-1306)' },
  { path: 'container/codex-version.sh', readBy: 'provision.sh: sourced for codex_version_matches (B-1306)' },
  { path: 'scripts/setup-channel-env.sh', readBy: 'provision.sh: writes the run dir settings (B-488)' },
];

export const WORKER_GENERATED: readonly RuntimePath[] = [
  { path: 'dist/index.js', readBy: 'the MCP server (.mcp.json)' },
  { path: 'dist/bin/harmony.js', readBy: 'provision.sh and the harmony shim; the skills' },
  { path: 'dist/bin/codex-auth.js', readBy: 'provision.sh: Codex token-only legs (B-1306)' },
  { path: 'dist/bin/poll.js', readBy: 'the harmony-conduct skill (background poll)' },
  { path: 'dist/bin/stop-gate.js', readBy: 'hooks/stop-gate.sh' },
  { path: 'dist/bin/pretooluse-gate.js', readBy: 'hooks/pretooluse-gate.sh' },
  { path: 'dist/bin/seat-hook.js', readBy: 'hooks/seat-session-start.sh and hooks/seat-stop-guard.sh' },
  { path: 'dist/THIRD_PARTY_NOTICES', readBy: 'travels with the bundle (the bundled packages\' licences, B-1295)' },
];

/** What the conductor reads: the daemon, its launch / probe / reap templates and everything they run or source. */
export const CONDUCTOR_TRACKED: readonly RuntimePath[] = [
  { path: 'container/conductor-launch.sh', readBy: 'launchd / systemd supervisor of a local conductor' },
  { path: 'container/cloud-worker-launch.sh', readBy: 'cloud profile launch template' },
  { path: 'container/cloud-worker-probe.sh', readBy: 'cloud profile probe template' },
  { path: 'container/cloud-worker-reap.sh', readBy: 'cloud profile reap template' },
  { path: 'container/docker-worker-launch.sh', readBy: 'local docker profile launch template' },
  { path: 'container/docker-worker-reap.sh', readBy: 'local docker profile reap template' },
  { path: 'container/docker-host-worker-launch.sh', readBy: 'docker-host profile launch template' },
  { path: 'container/docker-host-worker-probe.sh', readBy: 'docker-host profile probe template' },
  { path: 'container/docker-host-worker-reap.sh', readBy: 'docker-host profile reap template' },
  { path: 'container/docker-host-common.sh', readBy: 'sourced by the three docker-host scripts' },
  { path: 'container/gke/', readBy: 'gke profile templates, gke-common.sh, gke-render-leg.mjs, gke-startup-status.mjs, the sweep' },
  { path: 'container/figma/launch-context.sh', readBy: 'sourced by every launcher (B-1201)' },
  { path: 'container/codex-provider-launch.sh', readBy: 'sourced by every launcher (B-1178)' },
  { path: 'container/codex-token-launch.sh', readBy: 'sourced by every launcher (B-1306)' },
  { path: 'scripts/mint-installation-token.mjs', readBy: 'every launcher: mints the leg token and env file' },
  { path: 'scripts/resume-discovery.mjs', readBy: 'docker and docker-host launchers (B-718)' },
  { path: 'scripts/check-app-installation.mjs', readBy: '`harmony conductor check-app` (B-1433)' },
];

export const CONDUCTOR_GENERATED: readonly RuntimePath[] = [
  { path: 'dist/bin/daemon.js', readBy: 'the conductor process (conductor-launch.sh, the pod)' },
  { path: 'dist/bin/conductor-boot.js', readBy: 'the remote conductor pod entrypoint' },
  { path: 'dist/bin/harmony.js', readBy: 'launchers: `harmony config get`, `figma context`, `agent provider`' },
];

export const RUNTIME_TRACKED_PATHS: readonly string[] = [...new Set([...WORKER_TRACKED, ...CONDUCTOR_TRACKED].map((p) => p.path))];
export const RUNTIME_GENERATED_PATHS: readonly string[] = [...new Set([...WORKER_GENERATED, ...CONDUCTOR_GENERATED].map((p) => p.path))];
