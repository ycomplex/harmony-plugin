import { describe, it, expect } from 'vitest';
import { detectSupervisor, shutdownLine, shouldInspectWorkerImage } from './supervisor.js';

describe('B-1166: detectSupervisor', () => {
  it('launchd by XPC_SERVICE_NAME', () => {
    expect(detectSupervisor({ XPC_SERVICE_NAME: 'com.ycomplex.harmony-daemon' })).toBe('launchd');
  });
  it('systemd by non-empty INVOCATION_ID', () => {
    expect(detectSupervisor({ INVOCATION_ID: 'abc123' })).toBe('systemd');
  });
  it('null otherwise (other XPC name, empty INVOCATION_ID, empty env)', () => {
    expect(detectSupervisor({ XPC_SERVICE_NAME: '0' })).toBeNull();
    expect(detectSupervisor({ INVOCATION_ID: '' })).toBeNull();
    expect(detectSupervisor({})).toBeNull();
  });
});

describe('B-1166: shutdownLine', () => {
  it('names the supervisor', () => {
    expect(shutdownLine('SIGTERM', 'launchd')).toBe('received SIGTERM — exiting (launchd owns restart)');
    expect(shutdownLine('SIGINT', 'systemd')).toBe('received SIGINT — exiting (systemd owns restart)');
  });
  it('unsupervised', () => {
    expect(shutdownLine('SIGTERM', null)).toBe('received SIGTERM — exiting (unsupervised)');
  });
});

describe('B-1166: shouldInspectWorkerImage', () => {
  it('true when docker is declared in launch, reap or probe', () => {
    expect(shouldInspectWorkerImage({ required_tools: { launch: ['bash', 'docker'] } })).toBe(true);
    expect(shouldInspectWorkerImage({ required_tools: { launch: ['node'], reap: ['docker'] } })).toBe(true);
    expect(shouldInspectWorkerImage({ required_tools: { probe: ['docker'] } })).toBe(true);
  });
  it('false when required_tools is declared without docker (gke/cloud/docker-host shapes)', () => {
    expect(shouldInspectWorkerImage({ required_tools: { launch: ['node', 'kubectl'], reap: ['kubectl'] } })).toBe(false);
    expect(shouldInspectWorkerImage({ required_tools: {} })).toBe(false);
  });
  it('required_tools absent: falls back to the launch template containing the word docker', () => {
    expect(shouldInspectWorkerImage({ launch: 'bash gke-worker-launch.sh {ticket}' })).toBe(false);
    expect(shouldInspectWorkerImage({ launch: 'docker run foo' })).toBe(true);
    expect(shouldInspectWorkerImage({})).toBe(false);
  });
});
