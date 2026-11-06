# Talk track: Demo Shelf LAB

Each `##` heading is one presenter step. This is a Tool-tier launcher: it shows the real state of the demos on this machine and starts or stops them through Docker. Nothing on it is simulated.

## Nothing here is simulated

Open with the disclaimer inverted: unlike the demo apps, this page shows the real state of your machine — which demos are running, which are installed but stopped, which are not installed. There is no mock or live toggle because there is nothing to fake.

## One page, one card per demo

Scroll the shelf. Each card is one demo with a status light from its health probe, a Start button, and a Stop button. The "planned" cards come from the catalog and are ideas, not built apps — say that before someone asks why a card will not start.

## The two-process trick

Explain the architecture: the shelf runs in Docker, non-root, read-only, with no Docker socket — so it cannot start anything itself. The small start agent on your machine (the `npm run agent` terminal) runs `docker compose up -d` / `down` on its behalf, and the shelf's buttons call it over loopback with a token.

## The three card states

Walk one card of each kind: **Running** (light is on, Stop is active), **Installed, stopped** (says "Installed, not answering"; Start is on, and may say "not built yet: Start builds it" before a first run), and **Not installed** (tag shown, Start off). A demo that answers its health check is never shown as not installed.

## Start something

Press Start on a stopped card. The agent runs compose, the card flips to Running, and the install check is re-run for that demo immediately. Click the demo's link to open it, then come back.

## Stop only what you pressed

Press Stop on the same card. Only that demo's compose project goes down; the shelf itself keeps running. The shelf refuses to start or stop its own compose project.

## Filter and search

Open "Filter by tag" and click chips — inside a group they are alternatives, across groups they all apply — then type in the search box. The All / Installed / Mock filter separates installed apps from hosted mock copies. The filtered view is shareable by its address.

## How a new demo gets a card

Every -LAB app ships a shelf entry and registers itself: run its `npm start` once and it appends itself to `.data/demos.local.json`; restart the shelf and the card is there. If a demo is cloned but shows Not installed, it is not where the registry looks — put it beside the shelf (or set `SHELF_DEMO_ROOT`) and press Refresh.

## If the agent is down

Stop the agent terminal in a spare window, reload, and show what happens: the shelf says the start agent is not running and disables both buttons. Start it again and the buttons come back. The shelf degrades honestly.

## Safety summary

The container is loopback-only, holds no secrets, fetches only registered URLs, and Start/Stop is only ever `docker compose up -d` or `down` for a registered id, from a same-origin click, with Docker's context on OrbStack. Point at docs/security.md for the trust boundary.

## Nothing to reset

Close with: there is no reset because there is no run state — your own entries live in `.data/demos.local.json`, and the seed registry is committed data. Refresh is the whole reset.
