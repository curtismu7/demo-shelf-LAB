import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProbeFetch } from '../src/probe.js';

// A real server stands in for "the host". The probe connects to probeHost (127.0.0.1 here) but must send the registered Host.
describe('probe fetch for a containerised shelf', () => {
  let server;
  let port;
  let seen;
  beforeEach(async () => {
    seen = null;
    server = http.createServer((req, res) => {
      seen = { host: req.headers.host, url: req.url, accept: req.headers.accept };
      if (req.url === '/redir') { res.writeHead(302, { location: '/api/health' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"schema":"demo-health/1"}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  afterEach(() => new Promise((r) => server.close(r)));

  it('connects to the probe host and sends the registered loopback Host header', async () => {
    const f = createProbeFetch({ probeHost: '127.0.0.1' });
    const res = await f(`http://localhost:${port}/api/health?x=1`, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(2000) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"schema":"demo-health/1"}');
    expect(seen).toEqual({ host: `localhost:${port}`, url: '/api/health?x=1', accept: 'application/json' });
  });
  it('hands a redirect back unfollowed, with its location', async () => {
    const res = await createProbeFetch({ probeHost: '127.0.0.1' })(`http://127.0.0.1:${port}/redir`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/api/health');
  });
  it('uses plain fetch for anything that is not an http loopback URL', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'));
    const f = createProbeFetch({ probeHost: '127.0.0.1', fetchImpl });
    await f('https://mocks.example/h');
    await f('http://mocks.example/h');
    await f('http://192.168.1.5:80/h');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('rejects when nothing listens, so the poller shows the demo as down', async () => {
    await expect(createProbeFetch({ probeHost: '127.0.0.1' })('http://127.0.0.1:1/', {})).rejects.toBeTruthy();
  });
});
