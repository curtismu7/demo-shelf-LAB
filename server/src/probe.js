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
          try {
            const status = res.statusCode;
            // A status the Response constructor refuses (outside 200-599) is a failed probe, not a crash.
            if (!(status >= 200 && status <= 599)) { res.destroy(); return reject(new Error('bad-status')); }
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers)) for (const x of [].concat(v)) headers.append(k, x);
            const noBody = status === 204 || status === 205 || status === 304;
            if (noBody) res.resume();
            res.on('error', () => {}); // a reset mid-body surfaces through the Response stream
            resolve(new Response(noBody ? null : Readable.toWeb(res), { status, headers }));
          } catch (e) {
            res.destroy();
            reject(e);
          }
        },
      );
      req.on('error', reject);
      req.end();
    });
  };
}
