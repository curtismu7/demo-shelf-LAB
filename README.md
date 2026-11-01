# Demo Shelf LAB

Tier: Tool
Repo: https://github.com/ping-sandbox/demo-shelf-LAB

The launcher for every Ping demo on your machine. One page, one card per demo, a status light on each card (ready, needs setup, broken, down), search, tag filters, a copy-ready start command, and the planned ideas from the catalog. It runs on your laptop, listens on loopback only, and holds no accounts, secrets or tokens.

Each demo you start adds itself to the shelf the first time (see "How demos get on the shelf"), so there is nothing to register by hand.

## Run from a clone

Needs Node 26 and OrbStack (Docker). Two processes, both on your machine:

```
git clone https://github.com/ping-sandbox/demo-shelf-LAB.git
cd demo-shelf-LAB
npm install
npm run agent           # the start agent: leave it running in its own terminal
npm run docker          # builds and starts the shelf container: http://127.0.0.1:4400
```

The shelf runs in Docker (non-root, read-only, no Docker socket). It cannot start containers itself, so the small **start agent** on your machine does `docker compose up -d` / `down` for the demos the shelf lists, and the shelf's Start and Stop buttons call it. If the agent is not running, the shelf says so and disables Start. Stop the shelf with `npm run docker:down`.

Keep this folder next to the demo folders (all under one parent, for example `~/Development`). The shelf finds demos, and demos find the shelf, by sitting side by side.

**Without the container:** `npm run build && npm start` runs the shelf directly on your machine at http://127.0.0.1:4400. It runs Docker itself, so no agent is needed. Use one or the other: both want port 4400.

## How demos get on the shelf

Every -LAB app ships `docs/shelf-entry.json` and a `scripts/shelf-register.mjs`. On `npm start` the app looks for a `demo-shelf-LAB` folder next to it. If its id is already on the shelf (the committed `data/demos.json` or your `.data/demos.local.json`) it does nothing. If not, it appends its entry to `.data/demos.local.json` and prints one line. Restart the shelf to see the new card. No shelf folder, or `SHELF_AUTOREGISTER=0`: it skips and the app starts as normal. An app started only with `docker compose up` cannot reach your shelf folder, so it does not register; run its `npm start` once, or add its entry by hand ([docs/registry.md](docs/registry.md)).

## What to do if the port is taken

The shelf uses 4400. If something else has it, run `SHELF_HOST_PORT=4491 npm run docker` for the container, or `SHELF_PORT=4491 npm start` host-run (any port; 4400 and up keeps clear of the demos). The agent uses 4405 (`SHELF_AGENT_PORT`). `npm run doctor` names the fix. `npm run dev` runs the API on 4400 and the page on 4401 with hot reload. Settings are in `.env.example`; the shelf reads real environment variables, not a `.env` file.

## Health

`GET /api/health` returns `demo-health/1` for the shelf itself. The shelf's server polls each registered demo's `/api/health` (3 s timeout, 4 KB cap, results cached 10 s). A demo with no endpoint but a page that loads shows "Up (no health contract)"; one that does not answer shows "Down". Contract in [docs/health-contract.md](docs/health-contract.md).

## Checks

```
npm test                          # server and page unit tests
npm run e2e                       # real browser against 7 fake demos; screenshots to .data/e2e-screenshots (git-ignored)
npm run e2e -- --real [url]       # read-only look at a demo that is already running
npm run e2e -- --kit <dir>        # runs a demo-health/1 kit from <dir> in mock mode on :4531 and expects Ready
```

`e2e` is not run by CI. It needs `npm run build` first and a Chromium for Playwright (`npx playwright install chromium`). To use a Chromium you already have, set `E2E_CHROMIUM` to its executable. It uses ports 4490 (shelf), 4520-4526 (fakes) and 4531 (kit) and stops everything it starts.

## Docs

- [docs/health-contract.md](docs/health-contract.md): the `demo-health/1` field table, what each light tells you, and a short example for adding `GET /api/health` to a demo.
- [docs/registry.md](docs/registry.md): the registry files, every field, tags, and the catalog regeneration command.
- [docs/security.md](docs/security.md): loopback, no secrets, the Start / Stop allowlist, the SSRF stance.
- [CHANGELOG.md](CHANGELOG.md).

## Registry and catalog

`data/demos.json` is the committed seed: the -LAB apps. Put your own entries or overrides in `.data/demos.local.json`, merged over the seed by `id`. Details in [docs/registry.md](docs/registry.md).

Each demo is either installed (runs on your machine, the default), mock (a hosted mock-only copy at `mockUrl`), or both. The page has an All / Installed / Mock filter. No mock copy is registered today, so Mock is empty.

To regenerate `data/catalog.json` from the plan (deterministic; commit the result):

```
npm run catalog -- /path/to/standalone-demo-family-plan.md
```

## Tags and search

Every demo carries tags (Ping products, use cases, simulated or real, standards and protocols). Open "Filter by tag", click chips (inside a group they are alternatives, across groups they all apply), type in the search box to match names, descriptions and tags, and share the filtered view by its address. How to add tags and groups: [docs/registry.md](docs/registry.md#tags).

## Safety

The container is published on `127.0.0.1` only and has no Docker access. Start / Stop runs only `docker compose up -d` or `down` for a registered demo, from a same-origin click, and only when Docker's context is OrbStack. The start agent listens on loopback with a token. The shelf fetches only registered URLs. No host beyond loopback is allowed unless `SHELF_ALLOWED_HOSTS` names it. Full notes in [docs/security.md](docs/security.md).
