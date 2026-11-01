# Changelog

## 1.0.0

- `npm run agent` starts the start agent and then runs `npm run docker`, which opens the shelf in your browser once it answers. `SHELF_AUTOSTART=0` and `SHELF_OPEN=0` turn these off; both are skipped under `CI`.

- First release as Demo Shelf LAB: a clean-history copy of the internal shelf, restyled to the shared LAB UI standard (shelves, boxes, status lights, Auto / Light / Dark picker), registered demos on the first shelf and planned ideas below, tag filters behind a toggle.
- The seed lists the -LAB apps. No host is allowed beyond loopback unless `SHELF_ALLOWED_HOSTS` names it.
- `GET /api/health` (`demo-health/1`) for the shelf itself.
- Docker always: the shelf runs in a non-root, read-only container with no Docker socket (`npm run docker`) and Start / Stop is always on, with no off switch. A host-side start agent (`npm run agent`, loopback, bearer token) runs `docker compose` for registered demos; the container probes demos through `host.docker.internal` with their own Host header. One Start or Stop button per card, by state.
