import { describe, expect, it, vi } from 'vitest';
import { runCompose } from '../src/control.js';

const demo = (id) => ({ id, name: `Demo ${id}`, composeFile: `/labs/${id}/docker-compose.yml`, composeOverlays: [] });
const all = Array.from({ length: 14 }, (_, i) => demo(`d${i}`));
const project = (id) => ({ Name: id, Status: 'running(1)', ConfigFiles: `/labs/${id}/docker-compose.yml` });
// `up` = ids that are running now; every compose call is recorded.
const world = (up, { stopFails = false } = {}) => {
  const calls = [];
  const exec = vi.fn(async (f, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'context') return { stdout: 'orbstack', stderr: '' };
    if (args[0] === 'compose' && args[1] === 'ls') return { stdout: JSON.stringify([...up.map(project), { Name: 'other-stack', Status: 'running(3)', ConfigFiles: '/elsewhere/c.yml' }]), stderr: '' };
    if (args[0] === 'info') return { stdout: 'null', stderr: '' };
    if (args[0] === 'network') return { stdout: 'a\nb', stderr: '' };
    if (stopFails && args.includes('down')) { const e = new Error('boom'); e.stdout = ''; e.stderr = 'boom'; throw e; }
    return { stdout: 'ok', stderr: '' };
  });
  return { exec, calls };
};
const lastRunning = (ids) => ({ list: () => ids.map((id, i) => ({ id, ts: 100 - i })), recordStop: vi.fn() }); // most recent first
const run = (target, w, cap) => runCompose(target, 'start', { exec: w.exec, fileExists: () => true, cap: { getDemos: () => all, max: 3, ...cap } });

describe('running cap', () => {
  it('under the limit: starts, stops nothing', async () => {
    const w = world(['d0', 'd1']);
    const r = await run(demo('d9'), w, { lastRunning: lastRunning(['d1', 'd0']) });
    expect(r.status).toBe(200);
    expect(r.body.stopped).toBeUndefined();
    expect(w.calls.filter((c) => /\bdown\b/.test(c))).toEqual([]);
  });
  it('at the limit: stops the oldest started, then starts the new one, and says which', async () => {
    const w = world(['d0', 'd1', 'd2']);
    const lr = lastRunning(['d2', 'd0', 'd1']); // d1 was started longest ago
    const r = await run(demo('d9'), w, { lastRunning: lr });
    expect(r.status).toBe(200);
    expect(r.body.stopped).toEqual([{ id: 'd1', name: 'Demo d1' }]);
    expect(lr.recordStop).toHaveBeenCalledWith('d1');
    const compose = w.calls.filter((c) => c.startsWith('compose -f'));
    expect(compose[0]).toMatch(/d1\/docker-compose.yml down/);
    expect(compose[1]).toMatch(/d9\/docker-compose.yml.* up -d/);
  });
  it('a demo that was started outside the shelf counts as the oldest', async () => {
    const w = world(['d0', 'd1', 'd2']);
    const r = await run(demo('d9'), w, { lastRunning: lastRunning(['d0', 'd1']) }); // d2 is not recorded
    expect(r.body.stopped).toEqual([{ id: 'd2', name: 'Demo d2' }]);
  });
  it('already over the limit: refuses, stops nothing, and says how many are running', async () => {
    const w = world(['d0', 'd1', 'd2', 'd3', 'd4']);
    const r = await run(demo('d9'), w, { lastRunning: lastRunning([]) });
    expect([r.status, r.body.error]).toEqual([409, 'too-many-running:5:3']);
    expect(r.body.output).toMatch(/5 demos are running and the limit is 3/);
    expect(w.calls.filter((c) => /\b(down|up)\b/.test(c))).toEqual([]);
  });
  it('restarting a demo that is already running does not count it twice', async () => {
    const w = world(['d0', 'd1', 'd2']);
    const r = await run(demo('d1'), w, { lastRunning: lastRunning(['d1', 'd0', 'd2']) });
    expect(r.status).toBe(200);
    expect(r.body.stopped).toBeUndefined();
  });
  it('if the oldest will not stop, the start is refused and the error says why', async () => {
    const w = world(['d0', 'd1', 'd2'], { stopFails: true });
    const r = await run(demo('d9'), w, { lastRunning: lastRunning(['d2', 'd1', 'd0']) });
    expect([r.status, r.body.error]).toEqual([502, 'could-not-stop-oldest']);
    expect(w.calls.some((c) => / up -d/.test(c))).toBe(false);
  });
  it('never stops the shelf itself', async () => {
    const w = world(['d0', 'd1', 'd2']);
    const shelf = { ...demo('d0'), composeFile: '/labs/d0/docker-compose.yml' };
    const r = await runCompose(demo('d9'), 'start', { exec: w.exec, fileExists: () => true, shelfDir: '/labs/d0', cap: { getDemos: () => [shelf, ...all.slice(1)], max: 2, lastRunning: lastRunning(['d2', 'd1']) } });
    expect(r.status).toBe(200);
    expect(r.body.stopped).toEqual([{ id: 'd1', name: 'Demo d1' }]);
  });
  it('never picks ai-guard-sidecar as the oldest, even when it is the oldest', async () => {
    const guard = { ...demo('ai-guard-sidecar') };
    const w = world(['ai-guard-sidecar', 'd1', 'd2']);
    const r = await runCompose(demo('d9'), 'start', { exec: w.exec, fileExists: () => true, cap: { getDemos: () => [guard, ...all], max: 3, lastRunning: lastRunning(['d2', 'd1']) } }); // guard is not recorded = would rank oldest
    expect(r.status).toBe(200);
    expect(r.body.stopped).toEqual([{ id: 'd1', name: 'Demo d1' }]);
    expect(w.calls.some((c) => /ai-guard-sidecar\/docker-compose.yml down/.test(c))).toBe(false);
  });
  it('at the limit with only never-stopped demos running: refuses and stops nothing', async () => {
    const guard = { ...demo('ai-guard-sidecar') };
    const w = world(['ai-guard-sidecar']);
    const r = await runCompose(demo('d9'), 'start', { exec: w.exec, fileExists: () => true, cap: { getDemos: () => [guard, ...all], max: 1, lastRunning: lastRunning([]) } });
    expect([r.status, r.body.error]).toEqual([409, 'no-demo-to-stop:1:1']);
    expect(w.calls.filter((c) => /\b(down|up)\b/.test(c))).toEqual([]);
  });
  it('without a cap, nothing changes and docker compose ls is not even asked', async () => {
    const w = world(['d0', 'd1', 'd2', 'd3']);
    const r = await runCompose(demo('d9'), 'start', { exec: w.exec, fileExists: () => true });
    expect(r.status).toBe(200);
    expect(w.calls.some((c) => c.startsWith('compose ls'))).toBe(false);
  });
});
