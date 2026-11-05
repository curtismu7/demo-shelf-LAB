import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, Drawer } from "./Card.jsx";
import { LABELS, STATES } from "./status.js";
import ShelfLink from "./components/ShelfLink.jsx";

const REFRESH_MS = 30000;

// What a refused Start / Stop means, in words a person can act on.
const WHY = {
  "agent-not-running": "the start agent is not running. In the demo-shelf-LAB folder run: npm run agent",
  "agent-token-rejected": "the start agent rejected the shelf's token. Restart the shelf with: npm run docker",
  "compose-file-missing": "its compose file was not found beside the shelf. Check the registered path in Details",
  "docker-context-not-orbstack": "Docker's context is not OrbStack. Run: docker context use orbstack",
  "docker-unavailable": "Docker is not running. Start OrbStack",
  timeout: "Docker took too long (the first Start builds the image and may need a few minutes). Check the demo's logs",
  busy: "another start or stop for this demo is still running",
  "is-the-shelf": "that entry is the shelf itself, and Stop would take the shelf down. Stop it from a terminal with npm run docker:down",
  "no-repo": "no GitHub repo is registered for this demo. Use Start",
  "no-demo-root": "no demo root folder is set (SHELF_DEMO_ROOT); the shelf does not know where to clone",
  "git-clone-failed": "cloning the repo failed. Check the repo URL in Details and your network",
  "git-pull-failed": "updating the repo failed (it may have local changes). Update it from a terminal, then press Start",
  "detached-head": "the repo folder is on a detached HEAD that is behind main. In that folder run: git checkout main  (then press Deploy again)",
  "git-fetch-failed": "could not fetch the repo (network?). Try again, or update the folder from a terminal",
  "deploy-dir-not-a-repo": "the deploy folder exists but is not a git clone. Remove or rename it, then press Deploy again",
  "deploy-needs-host-shelf": "Deploy works when the shelf runs on the host (npm start), not in the container",
};

async function call(path, method = "GET") {
  const res = await fetch(path, { method });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function toItems(data) {
  const reg = data.demos.map((d) => ({ ...d, planned: false }));
  const planned = data.planned.map((p) => ({ ...p, catalogId: p.id, planned: true }));
  return [...reg, ...planned];
}

const THEMES = [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]];
const WHERES = [["all", "All"], ["installed", "Installed"], ["mock", "Mock"]];
const kindOf = (i) => (i.kind || "").toLowerCase();

// The page opens on Ready; ?status=all (or another state) overrides it.
const DEFAULT_STATUS = "ready";

// Filter state that is worth sharing lives in the address: ?q=oidc&tags=pingfederate,real&status=all
function fromAddress() {
  try {
    const p = new URLSearchParams(window.location.search);
    const st = p.get("status");
    return {
      q: p.get("q") || "",
      tags: new Set((p.get("tags") || "").split(",").map((t) => t.trim()).filter(Boolean)),
      status: st === "all" || STATES.includes(st) ? st : DEFAULT_STATUS,
    };
  } catch {
    return { q: "", tags: new Set(), status: DEFAULT_STATUS };
  }
}

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Which card action is in flight, as "id/action", so that card can show a spinner while it waits.
  const [activeAction, setActiveAction] = useState(null);
  const [note, setNote] = useState(null);
  const [announce, setAnnounce] = useState("");
  const [where, setWhere] = useState("all");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState(() => fromAddress().status);
  const [text, setText] = useState(() => fromAddress().q);
  const [picked, setPicked] = useState(() => fromAddress().tags);
  const [present, setPresent] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [theme, setTheme] = useState(() => {
    try { return window.localStorage.getItem("shelf-theme") || "auto"; } catch { return "auto"; }
  });
  const [open, setOpen] = useState(null);
  const prev = useRef(null);
  const opener = useRef(null);
  const closeRef = useRef(null);

  const load = useCallback(async (refresh) => {
    try {
      const next = await call(refresh ? "/api/shelf/refresh" : "/api/shelf", refresh ? "POST" : "GET");
      if (prev.current) {
        const changes = next.demos
          .filter((d) => prev.current[d.id] && prev.current[d.id] !== d.status.state)
          .map((d) => `${d.name} is now ${LABELS[d.status.state] || d.status.state}`);
        if (changes.length) setAnnounce(changes.join(". "));
      }
      prev.current = Object.fromEntries(next.demos.map((d) => [d.id, d.status.state]));
      setData(next);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load(false);
    const tick = () => { if (!document.hidden) load(false); };
    const t = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [load]);

  useEffect(() => {
    if (present) document.documentElement.dataset.present = "1";
    else delete document.documentElement.dataset.present;
    return () => { delete document.documentElement.dataset.present; };
  }, [present]);

  useEffect(() => {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem("shelf-theme", theme); } catch { /* the choice is a convenience */ }
  }, [theme]);

  // The server checks what is installed in the background. Until the first answer is in, look again soon instead of in 30 s.
  const pendingTries = useRef(0);
  useEffect(() => {
    if (!data?.installPending) { pendingTries.current = 0; return undefined; }
    if (pendingTries.current >= 12) return undefined;
    const t = setTimeout(() => { pendingTries.current += 1; load(false); }, 2500);
    return () => clearTimeout(t);
  }, [data, load]);

  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);

  async function act(id, action) {
    setBusy(true);
    setActiveAction(`${id}/${action}`);
    setNote(`${action} ${id}...`);
    try {
      await call(`/api/demos/${encodeURIComponent(id)}/${action}`, "POST");
      setNote(`${id}: ${action} done`);
    } catch (e) {
      setNote(`${id}: ${action} did not run: ${WHY[e.message] || e.message}`);
    }
    setBusy(false);
    setActiveAction(null);
    load(true);
  }

  async function copy(item) {
    const ok = await copyText(item.startCommand);
    setAnnounce(ok ? `Copied the start command for ${item.name}` : "Copy was blocked by the browser. Select the command in Details instead.");
    return ok;
  }

  function showDetails(item) {
    opener.current = document.activeElement;
    setOpen({ planned: item.planned, id: item.id });
  }
  function closeDetails() {
    setOpen(null);
    opener.current?.focus?.();
  }

  const items = useMemo(() => (data ? toItems(data) : []), [data]);
  const openItem = open && items.find((i) => i.planned === open.planned && i.id === open.id);
  const counts = useMemo(() => {
    const c = Object.fromEntries(STATES.map((s) => [s, 0]));
    for (const i of items) c[i.status.state] = (c[i.status.state] || 0) + 1;
    return c;
  }, [items]);

  const tagGroups = data?.tagGroups || [];
  const tagInfo = useMemo(() => new Map(tagGroups.flatMap((g) => g.tags.map((t) => [t.id, { ...t, group: g.id }]))), [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // A picked tag the server does not know (an old link) is dropped once the taxonomy has arrived.
  useEffect(() => {
    if (data && picked.size && [...picked].some((t) => !tagInfo.has(t))) setPicked(new Set([...picked].filter((t) => tagInfo.has(t))));
  }, [data, tagInfo, picked]);

  useEffect(() => {
    try {
      const p = new URLSearchParams();
      if (text.trim()) p.set("q", text.trim());
      if (picked.size) p.set("tags", [...picked].join(","));
      if (status !== DEFAULT_STATUS) p.set("status", status);
      window.history.replaceState(null, "", p.toString() ? `?${p}` : window.location.pathname);
    } catch { /* the address is a convenience */ }
  }, [text, picked, status]);

  const toggleTag = useCallback((id) => setPicked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);

  // Within one tag group the picked tags are alternatives (OR); across groups they all have to hold (AND).
  const passesBase = (i) => {
    const q = text.trim().toLowerCase();
    return (where === "all" || i.where === where) &&
      (kind === "all" || (kind === "unclassified" ? !i.kind : kindOf(i).includes(kind))) &&
      (status === "all" || i.status.state === status) &&
      (!q || [i.name, i.catalogId, ...(i.alsoCatalogIds || []), i.description, ...(i.tags || []).flatMap((t) => [t, tagInfo.get(t)?.label])].some((f) => (f || "").toLowerCase().includes(q)));
  };
  const passesTags = (i, skip) => tagGroups.every((g) => {
    if (g.id === skip) return true;
    const mine = g.tags.filter((t) => picked.has(t.id));
    return !mine.length || mine.some((t) => i.tags?.includes(t.id));
  });
  const shown = useMemo(() => items.filter((i) => passesBase(i) && passesTags(i)), [items, where, kind, status, text, picked, tagGroups]); // eslint-disable-line react-hooks/exhaustive-deps
  // How many cards each chip would give, with every other filter (and the other tag groups) applied.
  const tagCounts = useMemo(() => {
    const out = {};
    for (const g of tagGroups) {
      const pool = items.filter((i) => passesBase(i) && passesTags(i, g.id));
      for (const t of g.tags) out[t.id] = pool.filter((i) => i.tags?.includes(t.id)).length;
    }
    return out;
  }, [items, where, kind, status, text, picked, tagGroups]); // eslint-disable-line react-hooks/exhaustive-deps

  // Registered demos stand on the first shelf. Planned ideas follow, one shelf per catalog group.
  const byPlan = (a, b) => (a.wave ?? 99) - (b.wave ?? 99) || String(a.catalogId).localeCompare(String(b.catalogId), undefined, { numeric: true });
  const sections = useMemo(() => {
    const groups = data?.groups || {};
    const letters = [...Object.keys(groups).sort(), "other"];
    const mine = shown.filter((i) => !i.planned).sort(byPlan);
    const planned = letters.map((g) => ({
      key: g,
      title: g === "other" ? "Planned · Other" : `Planned · ${g} · ${groups[g]}`,
      rows: shown.filter((i) => i.planned && (i.group && groups[i.group] ? i.group : "other") === g).sort(byPlan),
    }));
    return [{ key: "mine", title: "On your shelf", rows: mine }, ...planned].filter((sec) => sec.rows.length);
  }, [shown, data]);

  return (
    <>
      <header className="top">
        <div className="top__name">
          <h1>Demo<span className="top__dot">.</span> Shelf</h1>
          <p className="top__sub">Every Ping demo you can run on your laptop. Green is up. Grey is waiting for you to start it.</p>
        </div>
        <div className="top__tools">
            <ShelfLink />
          <div role="group" aria-label="Theme" className="seg">
            {THEMES.map(([v, label]) => (
              <button key={v} type="button" aria-pressed={theme === v} onClick={() => setTheme(v)}>{label}</button>
            ))}
          </div>
          <button type="button" aria-pressed={present} onClick={() => setPresent((p) => !p)}>Present</button>
          <button type="button" onClick={() => load(true)}>Refresh</button>
        </div>
      </header>
      <main className="room">
        <div className="sr" role="status" aria-live="polite">{announce}</div>
        {error && <div className="note" data-state="error" role="alert">Cannot reach the shelf server ({error}). {data ? "Showing the last known state." : "Is it running?"}</div>}
        {note && !present && <div className="note" role="status">{note}</div>}
        {data?.agent === "token-rejected" && !present && (
          <div className="note" role="status" data-state="warn">The start agent is running but refused the shelf's token, so Start and Stop cannot work. In the demo-shelf-LAB folder run <code className="mono">npm run docker</code> again to give the shelf the current token.</div>
        )}
        {data?.agent === "down" && !present && (
          <div className="note" role="status" data-state="warn">The start agent is not running, so Start and Stop cannot work. In the demo-shelf-LAB folder run <code className="mono">npm run agent</code> and leave it running.</div>
        )}
        {data && !present && (
          <p className="howto">Start any demo from its folder and it adds itself to this shelf the first time. Restart the shelf to see the new card.</p>
        )}
        {data && (
          <>
            <section className="lights" aria-label="Summary by status">
              {STATES.map((s) => (
                <button key={s} type="button" className="chip" data-state={s} aria-pressed={status === s} onClick={() => setStatus(status === s ? "all" : s)}>
                  <b>{counts[s]}</b> {LABELS[s]}
                </button>
              ))}
            </section>
            <form className="filters" role="search" onSubmit={(e) => e.preventDefault()}>
              <label>Search<input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, id, description or tag" /></label>
              <div role="group" aria-label="Where it runs" className="filters__where">
                {WHERES.map(([v, label]) => (
                  <button key={v} type="button" className="chip" aria-pressed={where === v} onClick={() => setWhere(v)}>{label}</button>
                ))}
              </div>
              <label>Kind
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="all">All kinds</option>
                  <option value="demo">Demo</option>
                  <option value="tester">Tester</option>
                  <option value="tool">Tool</option>
                  <option value="unclassified">Unclassified</option>
                </select>
              </label>
              <label>Status
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="all">All statuses</option>
                  {STATES.map((s) => <option key={s} value={s}>{LABELS[s]}</option>)}
                </select>
              </label>
            </form>
            {tagGroups.length > 0 && !tagsOpen && !picked.size && (
              <p className="tag-toggle"><button type="button" aria-expanded="false" onClick={() => setTagsOpen(true)}>Filter by tag</button> <span className="tag-filters__count" role="status">{shown.length} of {items.length} shown</span></p>
            )}
            {tagGroups.length > 0 && (tagsOpen || picked.size > 0) && (
              <section className="tag-filters" aria-label="Filter by tag">
                {tagGroups.map((g) => (
                  <div key={g.id} role="group" aria-label={g.label} className="tag-filters__row">
                    <span className="tag-filters__group">{g.label}</span>
                    {g.tags.map((t) => {
                      const on = picked.has(t.id);
                      const n = tagCounts[t.id] ?? 0;
                      return (
                        <button key={t.id} type="button" className="chip tag-chip" aria-pressed={on} disabled={!on && n === 0} title={t.hint} onClick={() => toggleTag(t.id)}>
                          {t.label} <small>{n}</small>
                        </button>
                      );
                    })}
                  </div>
                ))}
                <div className="tag-filters__bar">
                  <span className="tag-filters__count" role="status">{shown.length} of {items.length} shown</span>
                  {picked.size > 0 && <button type="button" onClick={() => setPicked(new Set())}>Clear tags</button>}
                  {picked.size === 0 && <button type="button" aria-expanded="true" onClick={() => setTagsOpen(false)}>Hide tags</button>}
                </div>
              </section>
            )}
            {sections.length === 0 && (
              <p className="empty">
                {where === "mock" && !items.some((i) => i.where === "mock")
                  ? "No mock copies yet."
                  : picked.size ? "Nothing matches these tags and filters. Planned ideas carry no Simulated or Real tag, so picking one of those hides them." : "Nothing matches these filters."}
              </p>
            )}
            {sections.map((sec) => (
              <section key={sec.key} className="shelf" aria-labelledby={`g-${sec.key}`}>
                <h2 id={`g-${sec.key}`} className="shelf__title">{sec.title}</h2>
                <div className="shelf__row">
                  {sec.rows.map((i) => (
                    <Card key={`${i.planned ? "p" : "r"}-${i.id}`} item={i} present={present} startEnabled={data.startEnabled} busy={busy || data.agent === "down" || data.agent === "token-rejected"}
                      activeAction={activeAction === `${i.id}/start` ? "start" : activeAction === `${i.id}/stop` ? "stop" : activeAction === `${i.id}/deploy` ? "deploy" : null}
                      onAction={act} onCopy={copy} onDetails={showDetails} tagInfo={tagInfo} picked={picked} onTag={toggleTag} />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </main>
      {openItem && <Drawer item={openItem} present={present} onClose={closeDetails} closeRef={closeRef} tagGroups={tagGroups} />}
    </>
  );
}
