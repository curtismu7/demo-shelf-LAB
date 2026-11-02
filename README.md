# Demo Shelf LAB

The launcher for every Ping demo on your machine: one page, one card per demo, a status light on each, and a Start or Stop button that works through Docker.

Tier: Tool
Repo: https://github.com/ping-sandbox/demo-shelf-LAB
Catalog: E2

## What is simulated

Nothing. The shelf shows the real state of the demos running on your machine. The "planned" cards come from the catalog (`data/catalog.json`) and are ideas, not built demos. It has no mock or live mode. It holds no accounts, secrets or provider tokens; its only secret is the start agent's local token (see Safety).

## Run from a clone

Needs Node 26 and OrbStack (Docker). Never Docker Desktop. Two processes, both on your machine:

```
git clone https://github.com/ping-sandbox/demo-shelf-LAB.git
cd demo-shelf-LAB
npm install
npm run doctor          # Node, registry, Docker context
npm run agent           # starts the start agent, builds and starts the shelf container, opens http://127.0.0.1:4400 in your browser
```

Leave that terminal open: it is the start agent.

The shelf runs in Docker (non-root, read-only, no Docker socket). It cannot start containers itself, so the small **start agent** on your machine does `docker compose up -d` / `down` for the demos the shelf lists, and the shelf's Start and Stop buttons call it. Every installed card has both a Start and a Stop button; the one that does not apply is greyed out, with a tooltip saying why. Stop takes down only the demo you pressed it on, and the shelf keeps running; the shelf refuses to start or stop any entry that is its own compose project. If the agent is not running, the shelf says so and disables both. `npm run agent` also runs `npm run docker` for you, which opens your browser once the shelf answers. Ctrl-C stops the agent but leaves the container running; stop that with `npm run docker:down`. If the container cannot start (for example another shelf holds port 4400), the agent stays up and says so; fix it and run `npm run docker`. Settings: `SHELF_AUTOSTART=0` makes `npm run agent` start only the agent; `SHELF_OPEN=0` stops the browser opening; both are skipped when `CI` is set, and `SHELF_AUTOSTART` is also skipped when `SHELF_DATA_DIR` is set (the container reads `./.data`).

### Running, installed but stopped, not installed

Each installed card tells you which of these it is:

- **Running.** The status light comes from the health probe, and Stop is on.
- **Installed, stopped.** The demo's compose file is on your machine and it is not answering its health check (stopped, still starting, or crashed); the card says "Installed, not answering". Start is on. If its Docker images are not built yet the card says "Installed, not built yet: Start builds it (can take a few minutes)". That is normal before the first Start; Start stays on.
- **Not installed.** The compose file is not on your machine (a fresh download of the shelf alone looks like this). The card shows a "Not installed" tag and Start is off. If the demo's entry has a `repo`, **Copy clone command** copies `git clone https://github.com/<org>/<name>.git`; clone it next to the shelf (or where `SHELF_DEMO_ROOT` points) and press Refresh (it re-checks at once).

How it is detected: the shelf in Docker cannot see your files, so the start agent looks, read-only. It checks that the registered compose file exists, then (OrbStack context only) runs `docker compose config --images` and `docker image inspect` to see whether the images are built. Answers are cached for 30 s and re-checked after a Start or Stop on that demo, and when you press Refresh (the page waits up to about 4 s for the new answer; a slower one lands on the page's next look). Loading the page never waits for it: for the first moments after it opens, and whenever the agent is not running, Docker is slow or the context is not OrbStack, a card shows no install text and behaves as before. A demo that answers its health check is never shown as not installed. Mock cards, planned ideas and entries with no compose file have no install state.

Keep this folder next to the demo folders (all under one parent, for example `~/Development`). The shelf finds demos, and demos find the shelf, by sitting side by side.

**Without the container:** `npm run build && npm start` runs the shelf directly on your machine at http://127.0.0.1:4400. It runs Docker itself, so no agent is needed. Use one or the other: both want port 4400.

## Settings file

The shelf reads real environment variables, not `~/Development/.env`. All are optional (`.env.example` lists them).

| Variable | Default | What it does |
| --- | --- | --- |
| `SHELF_HOST_PORT` | 4400 | Host port the container is published on (127.0.0.1 only) |
| `SHELF_PORT` | 4400 | Port when run without the container |
| `SHELF_AGENT_PORT` | 4405 | Port of the start agent (loopback only) |
| `SHELF_ALLOWED_HOSTS` | none | Extra hosts, besides loopback, a registered demo URL may use |
| `SHELF_DATA_DIR` | `.data` | Where your `demos.local.json` and the agent token live |
| `SHELF_DEMO_ROOT` | folder above the shelf | Where relative `composeFile` paths start |
| `SHELF_BIND` | 127.0.0.1 | Address to listen on without the container; anything else turns Start off |

## Ports, and what to do if the port is taken

Ports: the shelf listens on 4400 (set with `SHELF_HOST_PORT` for the container or `SHELF_PORT` without it, default 4400). The start agent listens on 4405 (`SHELF_AGENT_PORT`).
Port range for this app: 4400-4449.

If the port is taken:
1. Find what is using it:
   `lsof -iTCP:4400 -sTCP:LISTEN -n -P`
2. If it is an old copy of this app, stop that process: `kill <PID>`.
3. If it is something else, stop it, or start this app on another port:
   `SHELF_HOST_PORT=4491 npm run docker` (or `SHELF_PORT=4491 npm start`)
4. Do not use 8080, 5173, 3000, 4000, 4510, 4600-4601, 18080, 19080 or 19090.

## Mock and live modes

Not applicable: this is a Tool, with nothing to simulate.

## Health, doctor and reset

- `GET /api/health` returns `demo-health/1` for the shelf itself. The shelf's server polls each registered demo's `/api/health` (3 s timeout, 4 KB cap, results cached 10 s). A demo with no endpoint but a page that loads shows "Up (no health contract)"; one that does not answer shows "Down". Contract in [docs/health-contract.md](docs/health-contract.md).
- `npm run doctor` prints one line per check and exits 1 on failure: Node, port, registry, catalog, Docker CLI and context, and whether the start agent is running.
- There is nothing to reset: the shelf keeps no run state. Your own entries live in `.data/demos.local.json`.

## Docker

```
npm run agent      # leave it running: starts the agent and the container, http://127.0.0.1:4400
npm run docker     # the container alone (the agent must already be running)
```

The container is published on `127.0.0.1` only. It has no Docker socket and no mount of your demo folders. `npm run docker:down` stops it.

## Tests

```
npm test
```

On Node 26: 289 server tests and 77 web tests pass. `npm run e2e` drives a real browser against fake demos (needs Playwright's Chromium, not run in CI).

## Troubleshooting

- **Start says "the start agent is not running".** In the shelf folder run `npm run agent` and leave it running.
- **"The start agent refused the shelf's token".** Run `npm run docker` again; it gives the container the current token.
- **"Docker's context is not OrbStack".** Run `docker context use orbstack`.
- **A card says "Not installed" but the demo is cloned.** The registered path is relative to the folder above the shelf (or `SHELF_DEMO_ROOT`). Put the demo there, or set `SHELF_DEMO_ROOT`, then press Refresh. The compose-file check is read fresh each time; the Docker image check is cached for up to 30 s.
- **"Its compose file was not found beside the shelf".** The registered path is relative to the folder above the shelf. Some apps (privilege-demo, privilege-map, agent-mcp-door-demo) live in `AI-DEMO-Standalone/standalone/`: put the shelf there too, or set `SHELF_DEMO_ROOT`.
- **A demo is running but shows Down.** Check its health route with `curl -H 'Host: 127.0.0.1:<port>' http://127.0.0.1:<port>/api/health`. The shelf connects through `host.docker.internal` and sends that Host header.
- **Port taken.** See the ports section above.

## Ownership

Owner: the Ping AI demo family maintainers. Licence: MIT ([LICENSE](LICENSE)). Report problems as an issue on https://github.com/ping-sandbox/demo-shelf-LAB.

## How demos get on the shelf

Every -LAB app ships `docs/shelf-entry.json` and a `scripts/shelf-register.mjs`. On `npm start` the app looks for a `demo-shelf-LAB` folder next to it. If its id is already on the shelf (the committed `data/demos.json` or your `.data/demos.local.json`) it does nothing. If not, it appends its entry to `.data/demos.local.json` and prints one line. Restart the shelf to see the new card. No shelf folder, or `SHELF_AUTOREGISTER=0`: it skips and the app starts as normal. An app started only with `docker compose up` cannot reach your shelf folder, so it does not register; run its `npm start` once, or add its entry by hand ([docs/registry.md](docs/registry.md)).

## Docs

- [docs/health-contract.md](docs/health-contract.md): the `demo-health/1` field table, what each light tells you, and a short example for adding `GET /api/health` to a demo.
- [docs/registry.md](docs/registry.md): the registry files, every field, tags, and the catalog regeneration command.
- [docs/security.md](docs/security.md): loopback, no secrets, the Start / Stop allowlist, the read-only install check, the SSRF stance.
- [CHANGELOG.md](CHANGELOG.md).

## Registry and catalog

`data/demos.json` is the committed seed: the -LAB apps. Put your own entries or overrides in `.data/demos.local.json`, merged over the seed by `id`. Details in [docs/registry.md](docs/registry.md).

Each demo is either installed (runs on your machine, the default), mock (a hosted mock-only copy at `mockUrl`), or both. The page has an All / Installed / Mock filter. No mock copy is registered today, so Mock is empty.

`data/catalog.json` is curated: only standalone apps and accepted proposals. To parse the whole plan into a scratch file instead (deterministic, never over the curated one):

```
npm run catalog -- /path/to/standalone-demo-family-plan.md --out /tmp/full-plan-catalog.json
```

## Tags and search

Every demo carries tags (Ping products, use cases, simulated or real, standards and protocols). Open "Filter by tag", click chips (inside a group they are alternatives, across groups they all apply), type in the search box to match names, descriptions and tags, and share the filtered view by its address. How to add tags and groups: [docs/registry.md](docs/registry.md#tags).

## Safety

The container is published on `127.0.0.1` only and has no Docker access. Start / Stop runs only `docker compose up -d` or `down` for a registered demo, from a same-origin click, and only when Docker's context is OrbStack. The start agent listens on loopback with a token. The shelf fetches only registered URLs. Full notes, including the trust boundary, in [docs/security.md](docs/security.md).
