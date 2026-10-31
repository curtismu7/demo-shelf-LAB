// Fake demo servers for the e2e run. Each answers like one case the shelf must tell apart.
// Not a demo: nothing here is shipped to an SE; it only exists so the shelf can be driven in a browser.
import http from 'node:http';

const health = (state, demo, extra = {}) => ({
  schema: 'demo-health/1', at: new Date().toISOString(), state, runtime: 'offline', demo: { id: demo, name: demo, version: '1.0.0' }, ...extra,
});

const page = (res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>fake demo</title><p>fake demo');
const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

// kind -> handler for GET /api/health ; every kind serves a page on /.
const KINDS = {
  ready: (res) => json(res, 200, health('ready', 'fake-ready')),
  'needs-setup': (res) => json(res, 200, health('needs-setup', 'fake-needs-setup')),
  broken: (res) => json(res, 200, health('broken', 'fake-broken')),
  unknown: (res) => json(res, 200, { ...health('ready', 'fake-unknown'), schema: 'demo-health/2' }), // off-contract schema
  hung: () => {}, // never answers; the shelf's 3 s timeout decides
  'no-contract': (res) => json(res, 404, { error: 'not found' }),
  'goes-down': (res) => json(res, 200, health('ready', 'fake-goes-down')),
};

export const KIND_NAMES = Object.keys(KINDS);

/** Starts one fake. Returns { server, stop() }. */
export function startFake(kind, port) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health' && req.method === 'GET') return KINDS[kind](res);
    if (req.url === '/' && kind !== 'hung') return page(res);
    if (kind === 'hung') return; // hung demo: nothing answers
    json(res, 404, { error: 'not found' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      server,
      stop: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
    }));
  });
}
