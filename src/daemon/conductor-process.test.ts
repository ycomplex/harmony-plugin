import { describe, it, expect } from 'vitest';
import { matchConductors, needsCwd, parsePsOutput, tokenizeArgs } from './conductor-process.js';

const DIR = '/opt/harmony-plugin';
const mine = `node ${DIR}/dist/bin/daemon.js --config /home/op/.harmony/deployment.json --profile gke`;

describe('B-1171: parsePsOutput / tokenizeArgs', () => {
  it('parses "pid args" lines and skips junk', () => {
    expect(parsePsOutput('  12 node a.js\nnot a line\n 345 bash -c "x y"\n')).toEqual([
      { pid: 12, args: 'node a.js' },
      { pid: 345, args: 'bash -c "x y"' },
    ]);
  });
  it('honours quotes and escaped spaces', () => {
    expect(tokenizeArgs(`node "/a b/dist/bin/daemon.js" --x 'y z' c\\ d`)).toEqual(['node', '/a b/dist/bin/daemon.js', '--x', 'y z', 'c d']);
  });
});

describe('B-1171: matchConductors finds ONLY this checkout\'s conductor', () => {
  const m = (args: string, extra: Partial<Parameters<typeof matchConductors>[1]> = {}, pid = 100) =>
    matchConductors([{ pid, args }], { pluginDir: DIR, ...extra });

  it('matches node <this checkout>/dist/bin/daemon.js and reads --profile / --config', () => {
    const r = m(mine);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ pid: 100, profile: 'gke', config: '/home/op/.harmony/deployment.json' });
  });
  it('matches a bare daemon with no flags, a versioned node binary and node flags', () => {
    expect(m(`/usr/local/bin/node ${DIR}/dist/bin/daemon.js`)).toHaveLength(1);
    expect(m(`node22 ${DIR}/dist/bin/daemon.js`)).toHaveLength(1);
    expect(m(`node --max-old-space-size=512 -r /x/hook.js ${DIR}/dist/bin/daemon.js`)).toHaveLength(1);
    expect(m(`node ${DIR}/dist/bin/daemon.js --profile=cloud`)[0].profile).toBe('cloud');
  });
  it('does NOT match another checkout\'s daemon', () => {
    expect(m('node /other/harmony-plugin/dist/bin/daemon.js --profile gke')).toEqual([]);
    expect(m(`node ${DIR}-2/dist/bin/daemon.js`)).toEqual([]);
  });
  it('does NOT match the ticket-disk sweep job', () => {
    expect(m(`bash ${DIR}/container/gke/sweep-ticket-disks.sh --namespace harmony-legs`)).toEqual([]);
    // even one that mentions the daemon bundle in an argument
    expect(m(`bash ${DIR}/container/gke/sweep-ticket-disks.sh --note ${DIR}/dist/bin/daemon.js`)).toEqual([]);
  });
  it('does NOT match a harmony CLI invocation, including `conductor stop` naming daemon.js', () => {
    expect(m(`node ${DIR}/dist/bin/harmony.js conductor stop`)).toEqual([]);
    expect(m(`node ${DIR}/dist/bin/harmony.js conductor status --config ${DIR}/dist/bin/daemon.js`)).toEqual([]);
    expect(m('harmony conductor restart')).toEqual([]);
  });
  it('does NOT match the launcher shell script, a pgrep, or a defunct entry', () => {
    expect(m(`bash ${DIR}/container/conductor-launch.sh --profile gke`)).toEqual([]);
    expect(m(`pgrep -f ${DIR}/dist/bin/daemon.js`)).toEqual([]);
    expect(m(`node ${DIR}/dist/bin/daemon.js <defunct>`)).toEqual([]);
  });
  it('excludes a process started with a different --config when a config path is named', () => {
    expect(m(mine, { configPath: '/home/op/.harmony/deployment.json' })).toHaveLength(1);
    expect(m(mine, { configPath: '/home/op/other.json' })).toEqual([]);
    expect(m(`node ${DIR}/dist/bin/daemon.js`, { configPath: '/home/op/other.json' })).toHaveLength(1);
  });
  it('resolves a relative script (a hand-started `node dist/bin/daemon.js`) through the process cwd only', () => {
    const procs = [
      { pid: 7, args: 'node dist/bin/daemon.js --profile cloud' },
      { pid: 8, args: 'node dist/bin/daemon.js' },
    ];
    expect(needsCwd(procs)).toEqual([7, 8]);
    expect(matchConductors(procs, { pluginDir: DIR })).toEqual([]);
    const got = matchConductors(procs, { pluginDir: DIR, cwdByPid: new Map([[7, DIR], [8, '/elsewhere']]) });
    expect(got.map((p) => p.pid)).toEqual([7]);
  });
});
