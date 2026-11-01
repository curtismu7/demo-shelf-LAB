# Demo Shelf LAB

Tier: Tool. A local launcher that lists every registered demo with a status light, plus the planned ideas from the catalog. Node 26, Express server (`server/`), React + Vite page (`web/`), loopback only.

## Run and test
- Docker (the normal way): `npm install`, then `npm run agent` (start agent, keep running) and `npm run docker` serve http://127.0.0.1:4400 (`SHELF_HOST_PORT` changes it). `npm run docker:down` stops it.
- Host-run: `npm run build && npm start` (`SHELF_PORT`). It runs Docker itself, no agent needed.
- `npm test` runs the server and web tests. `npm run doctor` checks the port, the registry and Node.
- `npm run e2e` needs Playwright's Chromium; it is not part of CI.

## Where things live
- `data/demos.json` is the committed seed (the -LAB apps). `.data/demos.local.json` is the user's own file, git-ignored, merged by `id`.
- Each demo adds itself to `.data/demos.local.json` on `npm start` through `scripts/shelf-register.mjs` (a vendored copy; the canonical one is in AI-DEMO-Standalone). That script is not in this repo; this repo only reads the file.
- `web/src/standalone-ui.css` is the vendored shared stylesheet. Do not edit it. App CSS (`web/src/styles.css`) uses its tokens only: no colour literals, no `prefers-color-scheme`, no `!important`, no italics, BEM names.

## Rules that bite
- Loopback bind and Host check stay on. The shelf fetches only registered URLs plus `healthPath`.
- Every hosted host must be named in `SHELF_ALLOWED_HOSTS`; none is built in.
- No internal hostnames, tenant ids, personal names or customer names anywhere, including tests and docs. Use `.example` hosts.
- Start / Stop is always Docker and has no off switch. The container has no socket and no demo-folder mounts: it calls the start agent (`server/src/agent.js`), which runs `docker compose` for ids in the host's own registry. Never let a request carry a path or command. The container reaches demos through `host.docker.internal` with the registered Host header (`server/src/probe.js`). `SHELF_IN_DOCKER=1` is only for the image and needs `/.dockerenv`.
- Node 26 only. CI runs build, test, doctor, gitleaks and the forbidden-strings check.
