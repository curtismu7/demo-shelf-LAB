// In a container, 127.0.0.1 is the container, not your machine. The shelf therefore connects to the host (SHELF_PROBE_HOST, by
// default host.docker.internal) for registered loopback demos, but still sends the registered Host header, because the demos
// refuse any other. The probe host is fixed by the environment: no request can choose it. Other URLs go through plain fetch.
import http from 'node:http';
import { Readable } from 'node:stream';

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function createProbeFetch({ probeHost, fetchImpl = fetch, request = http.request }) {
  return function probeFetch(url, init = {}) {
    const u = new URL(url);
    if (u.protocol !== 'http:' || !LOOPBACK_NAMES.has(u.hostname)) return fetchImpl(url, init);
    return new Promise((resolve, reject) => {
      const req = request(
        { host: probeHost, port: u.port || 80, path: `${u.pathname}${u.search}`, method: init.method || 'GET', headers: { ...init.headers, host: u.host }, signal: init.signal },
        (res) => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) for (const x of [].concat(v)) headers.append(k, x);
          const empty = res.statusCode === 204 || res.statusCode === 304;
          resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  };
}
