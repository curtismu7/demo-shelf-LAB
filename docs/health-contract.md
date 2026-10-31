# Health contract: demo-health/1

A demo gets a status light on the shelf by answering one public request. Without it the demo still appears, as "Up (no health contract)".

```
GET /api/health          200, Content-Type: application/json, Cache-Control: no-store
{
  "schema": "demo-health/1",
  "at": "2026-10-21T12:00:00.000Z",
  "state": "ready",
  "runtime": "offline",
  "demo": { "id": "id-jag", "name": "ID-JAG Standalone", "version": "0.1.0" }
}
```

## Fields

| Field | Type | Values and limits |
| --- | --- | --- |
| `schema` | string | Exactly `demo-health/1`. Any other value shows as Unknown (`unknown-schema`). |
| `at` | string | ISO 8601 time of the last check. Optional for the shelf; shown nowhere that matters if missing. |
| `state` | string | `ready`, `needs-setup`, `broken` or `unknown`. Anything else shows as Unknown (`bad-state`). |
| `runtime` | string | `offline` (works with no outside tenant) or `live` (talks to a real tenant or server). Other values are ignored. |
| `demo.id` | string | Up to 64 characters. |
| `demo.name` | string | Up to 80 characters. |
| `demo.version` | string | Up to 32 characters. Shown in the details drawer. |

Rules for the demo: public (no sign-in), GET only, no counts, no message text, no secrets, no per-check detail. Keep the reply under 4 KB; a bigger reply shows as Unknown (`oversized`). Detail belongs on the demo's own admin-only doctor.

## What each light tells the SE

| Light | How the shelf decides | What it tells you | What to do |
| --- | --- | --- | --- |
| Ready | `state: ready` | The demo is running and says it is configured. | Present. |
| Needs setup | `state: needs-setup` | Running, but setup is incomplete (for example a missing tenant value). | Open it and run its doctor or setup page. |
| Broken | `state: broken` | Running, but it reports it cannot do its job. | Read its container logs and doctor output. |
| Unknown | `state: unknown`, or a reply that is off-contract (wrong schema, bad state, over 4 KB) | The demo answered but the shelf cannot trust the reply. | Fix `GET /api/health`. |
| Up (no health contract) | No usable health reply, but `GET /` returns 2xx | The page loads; the shelf cannot tell whether it is configured. | Probably fine. Add the endpoint to get a real answer. |
| Down | Nothing answered, the request timed out (3 s), the answer was an error, or a redirect left the registered origin | Not running, wrong port, or hung. | Copy the start command and run it; check the registered port. |

A JSON reply with no `schema` field (for example a JSON 404) is not treated as a health document: the shelf falls back to the page check.

## Adding the endpoint to a demo (Node + Express)

```js
// server/src/health.js
import express from 'express';

const DEMO = { id: 'my-demo', name: 'My demo', version: '0.1.0' };
let last = { state: 'unknown', at: null };

// Replace this with the demo's own "am I configured" check. Return true when everything it needs is present.
async function configured() {
  return Boolean(process.env.MY_REQUIRED_SETTING);
}

async function refresh() {
  try { last = { state: (await configured()) ? 'ready' : 'needs-setup', at: new Date().toISOString() }; }
  catch { last = { state: 'unknown', at: new Date().toISOString() }; }
}
refresh();
setInterval(refresh, 60_000).unref(); // a request never runs the check, so a poller cannot cause load

const router = express.Router();
router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ schema: 'demo-health/1', at: last.at || new Date().toISOString(), state: last.state,
             runtime: process.env.MY_TENANT_URL ? 'live' : 'offline', demo: DEMO });
});
export default router; // app.use('/api/health', router)
```

Run the check in the background, not per request, and cap its time. The ID-JAG kit's `server/src/health.js` does this with its doctor and is the reference implementation.

## Registering the demo

Add it to `.data/demos.local.json` (see [registry.md](registry.md)) with the URL the demo is served on. `healthPath` defaults to `/api/health`.
