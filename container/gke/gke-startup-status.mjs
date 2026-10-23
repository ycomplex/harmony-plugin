// B-1267: Kubernetes startup evidence, shared by the launcher's poll and timeout diagnosis.
// No cluster calls here. Read JSON from stdin; missing/invalid API reads are explicit diagnostics.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const mode = process.argv[2];
if (mode === 'started') {
  const pods = parse(input)?.items;
  // The worker container must actually have run, not just its init container or FUSE sidecar.
  const started = Array.isArray(pods) && pods.some(p => (p.status?.containerStatuses || [])
    .some(c => c.name === 'worker' && (c.state?.running || c.state?.terminated || c.lastState?.terminated)));
  process.exit(started ? 0 : 1);
}
const [pods, pvc, events] = input.split('\x1c').map(parse);
const messages = [];
const objects = [...(pods?.items || []), ...(pvc ? [pvc] : [])];
const uids = new Set(objects.map(o => o.metadata?.uid).filter(Boolean));
if (pvc?.status?.phase) messages.push('PVC ' + pvc.status.phase);
else messages.push('PVC status unavailable');
for (const p of pods?.items || []) {
  for (const c of p.status?.conditions || []) {
    if (c.status === 'False' && (c.type === 'PodScheduled' || c.reason === 'Unschedulable'))
      messages.push([c.reason, c.message].filter(Boolean).join(': '));
  }
  for (const c of [...(p.status?.initContainerStatuses || []), ...(p.status?.containerStatuses || [])]) {
    if (c.state?.waiting) messages.push([c.state.waiting.reason, c.state.waiting.message].filter(Boolean).join(': '));
  }
}
if (!Array.isArray(pods?.items) || !pods.items.length) messages.push('pod status unavailable');
if (Array.isArray(events?.items)) {
  // Core/v1 events carry involvedObject; lastTimestamp/eventTime/series cover both event shapes.
  const relevant = events.items.filter(e => uids.has(e.involvedObject?.uid) &&
    ['ProvisioningFailed', 'FailedScheduling', 'Failed', 'BackOff'].includes(e.reason));
  const time = e => e.lastTimestamp || e.eventTime || e.series?.lastObservedTime || e.metadata?.creationTimestamp || '';
  relevant.sort((a, b) => time(a).localeCompare(time(b)));
  for (const reason of ['ProvisioningFailed', 'FailedScheduling', 'Failed', 'BackOff']) {
    const e = relevant.filter(e => e.reason === reason).at(-1);
    if (e) messages.push(reason + ': ' + (e.message || 'no event message'));
  }
} else messages.push('events unavailable (check namespaced events read permission/API access)');
const detail = [...new Set(messages.filter(Boolean))].join('; ') || 'worker did not start';
// A single bounded line is the launcher-to-scheduler diagnostic contract; no arbitrary tail copied.
console.log(detail.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 2400));
