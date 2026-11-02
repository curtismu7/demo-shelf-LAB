# Registry

The shelf lists the demos in two files, merged by `id`:

1. `data/demos.json`: the committed seed (the demos that exist today).
2. `.data/demos.local.json`: yours, git-ignored. Same shape. An entry with a seed `id` overrides only the fields you give; a new `id` is added. Set `SHELF_DATA_DIR` to keep it elsewhere.

`SHELF_SEED_FILE` replaces the committed seed with another file; the e2e script uses it.

```json
{
  "demos": [
    {
      "id": "id-jag-kit",
      "name": "ID-JAG kit",
      "catalogId": "C1",
      "kind": "Demo",
      "description": "One sentence an SE would recognise.",
      "url": "http://localhost:18080",
      "healthPath": "/api/health",
      "composeFile": "my-demo/docker-compose.yml",
      "composeOverlays": ["/absolute/path/to/overlay.yml"],
      "notes": "Free text, not shown."
    }
  ]
}
```

| Field | Required | Rule |
| --- | --- | --- |
| `id` | yes | Lower case letters, digits and `-`, 2 to 41 characters, unique. With `where: "both"`, `<id>-mock` is reserved for the generated mock card. |
| `name`, `description` | yes | Up to 300 characters. |
| `url` | yes (not for `where: "mock"`) | `http` or `https` origin only: no path, query, fragment or credentials. Host must be `localhost`, `127.0.0.1` or `[::1]`, or listed in `SHELF_ALLOWED_HOSTS`. |
| `where` | no | `installed` (default), `mock` or `both`. Where the demo runs: on this machine, as a mock-only copy hosted, or both. `both` shows two cards, the second with the id `<id>-mock`. |
| `mockUrl` | when `where` is `mock` or `both` | `http` or `https` origin, optionally with a plain path prefix for a shared SE host (for example `https://mocks.<host>/<mock-name>`); no query, fragment or credentials. The health path is joined under the prefix. A non-loopback host must be in `SHELF_ALLOWED_HOSTS` (or the built-in SE list). The Mock card opens it and its status light polls `healthPath` there. Mock cards have no Start / Stop. |
| `repo` | no | The demo's GitHub repo, `https://github.com/<org>/<name>` with an optional `.git`. Letters, digits, `.`, `_` and `-` only; no query, fragment, user name, port, spaces or other characters (anything else stops the server and is named in the message). It is stored without `.git`. A card for a demo that is not installed uses it for a Copy button that copies exactly `git clone https://github.com/<org>/<name>.git`. |
| `catalogId` | no | A row id from `data/catalog.json` (for example `C1`). It places the card in its group and removes the "planned" card for that row. |
| `alsoCatalogIds` | no | Up to 10 more row ids the same app covers (for example `["A4", "A5"]`). The card stays under `catalogId`; these rows no longer show as planned ideas, and search finds the card by them. Each must be a catalog row, not the entry's own `catalogId`, and not claimed by another demo; the server warns at startup and `npm run doctor` fails otherwise. |
| `kind` | no | `Demo`, `Tester` or `Tool`; defaults to the catalog row's kind. |
| `tags` | no | Up to 20 tag ids from `data/tags.json` (see Tags below). An id that is not in the taxonomy stops the server and is named in the message. Shown as pills on the card and used by the tag filter. |
| `healthPath` | no | Plain path starting with `/`. Default `/api/health`. |
| `composeFile`, `composeOverlays` | no | `.yml` / `.yaml` paths with no shell characters or `..`: absolute, or relative to the demo root. The demo root is `SHELF_DEMO_ROOT`, and defaults to the folder above this shelf (where the demo repos sit). A relative path makes an entry portable across machines, so use it for new entries. Used for Copy start command and for Start / Stop (always on). Overlays need a `composeFile`. |

Whether a demo is installed is not a field: the start agent looks for the registered `composeFile` (and overlays) on your machine. See "Installed, stopped, not installed" in the README.

A bad file stops the server and the message names every problem.

## Tags

`data/tags.json` is the taxonomy: groups of tags, each tag with an `id` (lower case letters, digits and `-`, unique across all groups), a `label` and an optional `hint` (the tooltip). The starter groups are **Ping products**, **Use cases**, **Simulated or real** and **Standards and protocols**. To add a tag, add it to the taxonomy and list its id in the demos that carry it; to add a group, add a group (up to 12 groups, 60 tags each). A tag that no entry carries is a dead chip, so the seed test fails on one.

```json
{ "schema": "demo-tags/1", "groups": [ { "id": "standard", "label": "Standards and protocols", "tags": [ { "id": "dpop", "label": "DPoP (RFC 9449)" } ] } ] }
```

- **Simulated or real.** `simulated` = runs offline on fake data; `real` = can also run against something real (a PingOne or PingFederate tenant, or a server you point it at). The ids `simulated` and `real` are special: the generated `<id>-mock` card of a hosted copy is always `simulated` and never `real`, whatever the installed entry says.
- **Local entries.** `.data/demos.local.json` can set `tags` on a new entry or override them on a seed id (the whole list is replaced).
- **The filter.** Chips are grouped. Inside a group the picked chips are alternatives (OR); across groups they all have to hold (AND). Each chip shows how many cards it would give with every other filter applied, and a chip that would give none is disabled. The search box also matches tag names. Planned ideas from the catalog are tagged too (see below), but never with Simulated or Real, so picking either hides them.
- **Planned ideas.** `data/catalog.json` lists only the standalone apps (a repo on disk with a `docs/shelf-entry.json`) and accepted proposals, not the whole plan; `scripts/build-catalog.mjs` can still parse the full plan into another file with `--out`, but do not overwrite the curated file with it. The tags for its rows live in `data/catalog-tags.json`: `{ "schema": "demo-catalog-tags/1", "tags": { "C7": ["par", "oauth", "learning"] } }`. A tag id that is not in the taxonomy, or a row id that is not in the catalog, stops the server and is named in the message. A row with no entry just shows no pills. At startup the server prints the ids of any planned ideas that have no entry, so a regenerated catalog's new rows are noticed (it is a warning, not an error). Once a row has a registered demo, its entry here is ignored and the demo's own `tags` apply. `SHELF_CATALOG_TAGS_FILE` points at a different file.
- **Shareable.** The address carries the view: `?tags=pingfederate,real&q=token`. An id the server does not know is ignored.
- `SHELF_TAGS_FILE` points at a different taxonomy file. A missing `data/tags.json` means no tags: the page then shows no tag panel and any entry that lists a tag is refused.

## Catalog

`data/catalog.json` is generated from the plan's tables and drives the "planned" cards and the groups. Regenerate it after the plan changes:

```
npm run catalog -- /path/to/standalone-demo-family-plan.md
```

The output is deterministic; commit the result.
