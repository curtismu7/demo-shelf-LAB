# Verification marks

Each tile on the shelf can carry one mark: **Verified** (a green check) or **In progress** (an amber check), with a short note. A tile with no mark shows nothing. The marks tell users which demos someone has actually checked.

## Setting marks

Open **Verification** in the shelf's header (or `#/verify`). There is one row per registered demo: pick Not checked, In progress or Verified, type a note (up to 140 characters, no line breaks), press Save. The tile shows the new mark the next time the shelf looks (at most 30 seconds, or press Refresh); nothing restarts.

A mark you save is stored on this machine, in `.data/verification.local.json` (git-ignored), and the tile says **Set on this machine** next to it, so nobody mistakes it for a mark that ships with the shelf.

In the container the save goes to the start agent (`npm run agent`), which writes the file: the container mounts `.data` read-only. Host-run (`npm start`) the shelf writes it itself. If the agent is not running the page says so and keeps your draft.

## Shipping marks to everyone

`data/verification.json` is the committed file; it ships with the shelf, so everyone who updates sees it. To publish the marks you saved:

```
npm run verification:publish     # folds .data/verification.local.json into data/verification.json
git diff data/verification.json  # check it
```

Then commit the file in a pull request. A mark set to Not checked removes that tile's committed mark. Publishing twice changes nothing the second time. The local file is left alone: it keeps overriding until the PR is merged and the shelf rebuilt, and then says the same thing.

## File shape

```json
{ "schema": "demo-verification/1", "marks": { "<demo id>": { "status": "verified", "note": "Ran every step on the mock.", "updatedAt": "2026-11-15" } } }
```

`status` is `verified`, `in-progress` or (local file only) `none`, which hides a committed mark on this machine. A bad entry is skipped, never fatal. The local file wins over the committed one, by id. A test pins that every id in the committed file is a registered demo.

## One definition, used everywhere

The labels ("Verified", "In progress", "Not checked"), what each means, and the note limit are defined once, in `server/src/verification.js` (`STATUS_INFO`, `NOTE_MAX`). `GET /api/shelf` sends them as `verificationInfo`, and each demo carries `verification: { status, label, note, updatedAt, source } | null` (`source` is `shipped` or `local`). The tile, Details and the Verification page all draw from that and from one component, `VerifyBadge` in `web/src/components/VerifyMark.jsx`, with its look in `VerifyMark.css`. Both files are the shared `shared/verify-mark/` from AI-DEMO-Standalone, vendored byte for byte and pinned (`VerifyMark.sha256`, `VerifyMark.css.sha256`, checked by `verify-mark.pin.test.js`): change them there and re-vendor, never here. The labs use the same component (`<VerifyMark id="..." />` beside their Shelf button) and read the same field from `/api/shelf`, so a change to the shared files, or to a word in `verification.js`, reaches every app.

## Safety

The save is `PUT /api/verification/:id` with `{ status, note }`. It exists only while Start / Stop is on, needs a same-origin request from a loopback client (the same two guards as Start / Stop), names a registered id, and validates the status and note before touching a file. The request never carries a path. The agent route `PUT /v1/verification/:id` takes the same body behind the agent's token.
