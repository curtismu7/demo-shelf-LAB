import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
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
  it('does not rewrite https, even to a loopback name', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'));
    await createProbeFetch({ probeHost: '127.0.0.1', fetchImpl })('https://127.0.0.1:4443/h');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('rewrites 127.0.0.1, localhost and [::1], keeping each as the Host header', async () => {
    const seenOpts = [];
    const request = vi.fn((opts, cb) => {
      seenOpts.push(opts);
      const res = Object.assign(new Readable({ read() { this.push(null); } }), { statusCode: 200, headers: {} });
      setImmediate(() => cb(res));
      return { on() {}, end() {} };
    });
    const f = createProbeFetch({ probeHost: 'host.docker.internal', request });
    for (const u of ['http://127.0.0.1:6880/a', 'http://localhost:6881/b', 'http://[::1]:6882/c']) await f(u, {});
    expect(seenOpts.map((o) => [o.host, o.headers.host])).toEqual([
      ['host.docker.internal', '127.0.0.1:6880'], ['host.docker.internal', 'localhost:6881'], ['host.docker.internal', '[::1]:6882'],
    ]);
  });
  it('gives an empty body for 204, 205 and 304', async () => {
    for (const code of [204, 205, 304]) {
      const srv = http.createServer((req, res) => { res.statusCode = code; res.end(); });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const res = await createProbeFetch({ probeHost: '127.0.0.1' })(`http://127.0.0.1:${srv.address().port}/`, {});
      expect(res.status).toBe(code);
      expect(res.body).toBeNull();
      await new Promise((r) => srv.close(r));
    }
  });
  it('treats a status outside 200-599 as a failed probe instead of crashing the process', async () => {
    const socks = new Set();
    const srv = net.createServer((sock) => { socks.add(sock); sock.on('error', () => {}); sock.end('HTTP/1.1 700 Weird\r\nContent-Length: 0\r\n\r\n'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    await expect(createProbeFetch({ probeHost: '127.0.0.1' })(`http://127.0.0.1:${srv.address().port}/`, {})).rejects.toThrow('bad-status');
    socks.forEach((x) => x.destroy());
    await new Promise((r) => srv.close(r));
  });
  it('honours the abort signal when the demo hangs', async () => {
    const srv = http.createServer(() => {}); // never answers
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    await expect(createProbeFetch({ probeHost: '127.0.0.1' })(`http://127.0.0.1:${srv.address().port}/`, { signal: AbortSignal.timeout(200) })).rejects.toBeTruthy();
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  });
  it('rejects when nothing listens, so the poller shows the demo as down', async () => {
    await expect(createProbeFetch({ probeHost: '127.0.0.1' })('http://127.0.0.1:1/', {})).rejects.toBeTruthy();
  });
});
