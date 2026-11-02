# Changelog

## Unreleased

- `alsoCatalogIds` on a demo: extra catalog rows the one card covers (they stop showing as planned, and search finds the card by them). The server warns, and `npm run doctor` fails, on an id that is not a catalog row, repeats the entry's own `catalogId`, or is claimed by another demo.
- The seed lists pingone-signin-LAB under A11, covering A4 and A5.

## 1.0.0

- A Start button that cannot be pressed (not installed, no compose file) is drawn muted, not red, so it no longer looks clickable.

- Each installed card says whether the demo is running, installed but stopped, or not installed. The start agent checks for the registered compose file and whether its images are built (read-only `GET /v1/installs`; host-run the shelf does the same itself). "Not installed" greys out Start and shows a tag; with the new optional `repo` field it also offers Copy clone command. "Installed, not built yet" is normal before the first Start, which builds the images. If the check cannot tell (agent not running, Docker slow or not OrbStack), the card behaves as before. The seed entries carry their `repo`. Refresh re-checks the install state (so clone, then Refresh, works at once).

- Removed the unused `SHELF_ONLINE_ONLY` switch (hosted copies only); it had no setting in this repo. `npm test -w server` now allows 30 s per test, so it passes on a busy machine.

- Hovering (or tabbing into) a card lights it up in its kind colour: ring and glow in the spine colour (red Demo, blue Tester, grey Tool), a thicker spine and a faint tint. The colour change also applies with reduced motion; only the lift is motion.

- Every installed card shows Start and Stop side by side (the one that does not apply is disabled, with a tooltip). Stop stops only that demo. Start and Stop refuse an entry that is the shelf's own compose project (`is-the-shelf`), so a Stop can never take the shelf down.

- `npm run agent` starts the start agent and then runs `npm run docker`, which opens the shelf in your browser once it answers. `SHELF_AUTOSTART=0` and `SHELF_OPEN=0` turn these off; both are skipped under `CI`.

- First release as Demo Shelf LAB: a clean-history copy of the internal shelf, restyled to the shared LAB UI standard (shelves, boxes, status lights, Auto / Light / Dark picker), registered demos on the first shelf and planned ideas below, tag filters behind a toggle.
- The seed lists the -LAB apps. No host is allowed beyond loopback unless `SHELF_ALLOWED_HOSTS` names it.
- `GET /api/health` (`demo-health/1`) for the shelf itself.
- Docker always: the shelf runs in a non-root, read-only container with no Docker socket (`npm run docker`) and Start / Stop is always on, with no off switch. A host-side start agent (`npm run agent`, loopback, bearer token) runs `docker compose` for registered demos; the container probes demos through `host.docker.internal` with their own Host header. One Start or Stop button per card, by state.
