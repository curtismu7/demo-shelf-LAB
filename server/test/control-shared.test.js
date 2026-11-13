import { describe, expect, it, vi } from 'vitest';
import { runCompose, startSharedContainers } from '../src/control.js';
import { SHARED_CONTAINERS } from '../src/pingProducts.js';

const demo = (id, pingProducts) => ({ id, name: id, composeFile: `/labs/${id}/docker-compose.yml`, composeOverlays: [], pingProducts });
const project = (id) => ({ Name: id, Status: 'running(1)', ConfigFiles: `/labs/${id}/docker-compose.yml` });
// ps output per container: 'Up ...' = running, 'Exited ...' = stopped, '' = no such container
const world = (containers = {}) => {
  const calls = [];
  const exec = vi.fn(async (f, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'context') return { stdout: 'orbstack', stderr: '' };
    if (args[0] === 'compose' && args[1] === 'ls') return { stdout: '[]', stderr: '' };
    if (args[0] === 'info') return { stdout: 'null', stderr: '' };
    if (args[0] === 'network') return { stdout: 'a\nb', stderr: '' };
    if (args[0] === 'ps') {
      const name = String(args.find((a) => a.startsWith('name=')) || '').replace(/^name=\^/, '').replace(/\$$/, '');
      const st = containers[name];
      return { stdout: st ? `${st} x` : '', stderr: '' };
    }
    return { stdout: 'ok', stderr: '' };
  });
  return { exec, calls };
};

describe('startSharedContainers', () => {
  it('no pingProducts: nothing started', async () => {
    const w = world();
    expect(await startSharedContainers(demo('d1'), w.exec)).toEqual([]);
    expect(w.calls.filter((c) => c.includes('start '))).toEqual([]);
  });

  it('SaaS-only products: nothing started', async () => {
    const w = world();
    expect(await startSharedContainers(demo('d1', ['pingone', 'pingone-privilege']), w.exec)).toEqual([]);
    expect(w.calls.filter((c) => c.startsWith('start '))).toEqual([]);
  });

  it('stopped shared container is started; running one is left alone', async () => {
    const w = world({ [SHARED_CONTAINERS.pingfederate]: 'Up 2 hours', [SHARED_CONTAINERS.pinggateway]: 'Exited (137)' });
    const started = await startSharedContainers(demo('d1', ['pingfederate', 'pinggateway']), w.exec);
    expect(started).toEqual([SHARED_CONTAINERS.pinggateway]);
    expect(w.calls.filter((c) => c.startsWith('start '))).toEqual([`start ${SHARED_CONTAINERS.pinggateway}`]);
  });

  it('unknown container on this machine: skipped, not an error', async () => {
    const w = world();
    expect(await startSharedContainers(demo('d1', ['privilege-gateway']), w.exec)).toEqual([]);
  });
});

describe('runCompose starts shared services on Start', () => {
  it('start also docker-starts the demo\'s shared product containers', async () => {
    const w = world({ [SHARED_CONTAINERS.pingfederate]: 'Exited (137)' });
    const r = await runCompose(demo('d1', ['pingfederate']), 'start', { exec: w.exec, fileExists: () => true });
    expect(r.status).toBe(200);
    expect(r.body.sharedStarted).toEqual([SHARED_CONTAINERS.pingfederate]);
    expect(w.calls.filter((c) => c.startsWith('start ')).length).toBe(1);
    expect(w.calls.some((c) => c.includes('compose') && c.includes('up'))).toBe(true);
  });

  it('stop does not touch shared services', async () => {
    const w = world({ [SHARED_CONTAINERS.pingfederate]: 'Exited (137)' });
    const r = await runCompose(demo('d1', ['pingfederate']), 'stop', { exec: w.exec, fileExists: () => true });
    expect(r.status).toBe(200);
    expect(r.body.sharedStarted).toBeUndefined();
    expect(w.calls.filter((c) => c.startsWith('start '))).toEqual([]);
  });

  it('demo without pingProducts: no shared calls', async () => {
    const w = world();
    const r = await runCompose(demo('d1'), 'start', { exec: w.exec, fileExists: () => true });
    expect(r.status).toBe(200);
    expect(w.calls.filter((c) => c.startsWith('ps ') || c.startsWith('start '))).toEqual([]);
  });
});

import { stopSharedContainers } from '../src/control.js';

describe('stopSharedContainers', () => {
  it('stops only the Up shared containers, from every demo\'s pingProducts', async () => {
    const demos = [demo('a', ['pingfederate']), demo('b', ['pinggateway', 'pingone']), demo('c', ['privilege-gateway'])];
    const w = world({ [SHARED_CONTAINERS.pingfederate]: 'Up 2 hours', [SHARED_CONTAINERS.pinggateway]: 'Exited (137)', [SHARED_CONTAINERS['privilege-gateway']]: 'Up 1 minute' });
    const stopped = await stopSharedContainers(() => demos, w.exec);
    expect(stopped.sort()).toEqual([SHARED_CONTAINERS['privilege-gateway'], SHARED_CONTAINERS.pingfederate].sort());
    expect(w.calls.filter((c) => c.startsWith('stop ')).length).toBe(2);
  });

  it('no demos declare products: no calls', async () => {
    const w = world({ [SHARED_CONTAINERS.pingfederate]: 'Up 2 hours' });
    expect(await stopSharedContainers(() => [demo('a')], w.exec)).toEqual([]);
    expect(w.calls.filter((c) => c.startsWith('stop '))).toEqual([]);
  });
});
