import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, Drawer } from "./Card.jsx";
import { LABELS, BUCKETS, BUCKET_OF_STATE } from "./status.js";
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

async function call(path, method = "GET", jsonBody) {
  const res = await fetch(path, {
    method,
    ...(jsonBody !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(jsonBody) } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// Minimal markdown for the release notes: bold, inline code, bullets, headings.
function mdToNodes(md) {
  const inline = (t) => t
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
  const out = [];
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line) { out.push("<div style='height:6px'></div>"); continue; }
    if (line.startsWith("- ")) { out.push(`<div style='margin:2px 0 2px 14px;text-indent:-10px'>• ${inline(line.slice(2))}</div>`); continue; }
    if (/^\*\*[^*]+\*\*$/.test(line)) { out.push(`<div style='font-weight:700;margin-top:8px'>${inline(line)}</div>`); continue; }
    out.push(`<div>${inline(line)}</div>`);
  }
  return out.join("");
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
  // Bucket per the owner's four statuses. A demo that answers health is Running;
  // one in the catalog/GitHub but not deployed here is New; everything else
  // (cloned/installed but not answering) is Offline. "Deployed" counts every
  // installed demo (Running + Offline are its live subsets).
  const reg = data.demos.map((d) => {
    const stateBucket = BUCKET_OF_STATE[d.status?.state] || "offline";
    const installed = d.where === "installed" || d.install === "installed" || !("where" in d);
    let bucket;
    if (stateBucket === "running") bucket = "running";
    else if (!installed || d.install === "not-installed") bucket = "new";
    else bucket = stateBucket === "new" ? "new" : "offline";
    return { ...d, planned: false, bucket };
  });
  const planned = data.planned.map((p) => ({ ...p, catalogId: p.id, planned: true, bucket: "new" }));
  return [...reg, ...planned];
}

const THEMES = [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]];
const WHERES = [["all", "All"], ["installed", "Installed"], ["mock", "Mock"]];

// Filter state that is worth sharing lives in the address: ?q=oidc&tags=pingfederate,real
function fromAddress() {
  try {
    const p = new URLSearchParams(window.location.search);
    return {
      q: p.get("q") || "",
      tags: new Set((p.get("tags") || "").split(",").map((t) => t.trim()).filter(Boolean)),
    };
  } catch {
    return { q: "", tags: new Set() };
  }
}

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Which card action is in flight, as "id/action", so that card can show a spinner while it waits.
  const [activeAction, setActiveAction] = useState(null);
  const [note, setNote] = useState(null);
  // Update notice from the family's UPDATES.md: { notice, updateCommand } or null.
  const [updateNotice, setUpdateNotice] = useState(null);
  // Release notes: { version, notes, updateCommand } from /api/releases.
  // Open by default when `version` differs from the last one the user dismissed;
  // the dismissal persists in localStorage until the next version appears.
  const [releases, setReleases] = useState(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [releaseVersion, setReleaseVersion] = useState(null);
  const [announce, setAnnounce] = useState("");
  const [where, setWhere] = useState("all");
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

  // Rule 19: the Mock/Real toggle. The shelf is a launcher with no live mode, so Real is always disabled
  // with the server's reason; the control still exists in the header and reports the honest answer.
  const [modeInfo, setModeInfo] = useState(null);
  useEffect(() => { call("/api/info").then(setModeInfo).catch(() => {}); }, []);
  const selectMode = useCallback(async (source) => {
    if (source === (modeInfo?.source || "mock")) return;
    try {
      const r = await call("/api/mode", "POST");
      // call() only throws on !ok: a mock switch returns 200 and the info is refreshed.
      void r;
      setModeInfo(await call("/api/info"));
      load(true);
    } catch (e) {
      setAnnounce(e.message);
    }
  }, [modeInfo, load]);

  useEffect(() => {
    load(false);
    const tick = () => { if (!document.hidden) load(false); };
    const t = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [load]);

  // Update notice: fetched once per page load; the server caches upstream for 5 min.
  useEffect(() => {
    fetch("/api/notice").then((r) => r.json()).then((b) => {
      if (b && b.notice) setUpdateNotice(b);
    }).catch(() => { /* no notice is fine */ });
  }, []);

  // Release notes: open automatically when a NEW version appears (one the user
  // has not dismissed); stay closed once dismissed until the version changes.
  useEffect(() => {
    fetch("/api/releases").then((r) => r.json()).then((b) => {
      if (!b || !b.notes || !b.version) return;
      setReleases(b);
      setReleaseVersion(b.version);
      let seen = null;
      try { seen = window.localStorage.getItem("shelf-releases-seen"); } catch { /* private mode */ }
      setNotesOpen(seen !== b.version);
    }).catch(() => { /* no release notes is fine */ });
  }, []);

  const dismissNotes = () => {
    setNotesOpen(false);
    try { if (releaseVersion) window.localStorage.setItem("shelf-releases-seen", releaseVersion); } catch { /* private mode */ }
  };

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

  // Deploy-all: bring every down/not-installed demo up, one at a time (the start
  // agent is serial anyway). Progress lands in the note line as each finishes.
  const [deployAllRunning, setDeployAllRunning] = useState(false);
  async function deployAll() {
    if (!data || deployAllRunning) return;
    const targets = data.demos.filter((d) => !d.isShelf && ["down", "not-installed", "broken"].includes(d.status?.state));
    if (!targets.length) { setAnnounce("Everything is already up"); setNote("Nothing to deploy — every demo is up."); return; }
    setDeployAllRunning(true);
    let okCount = 0; const failed = [];
    for (const d of targets) {
      setNote(`deploy-all: ${d.name} (${okCount}/${targets.length} done)...`);
      try {
        await call(`/api/demos/${encodeURIComponent(d.id)}/deploy`, "POST");
        okCount += 1;
      } catch (e) {
        failed.push(d.name);
        setNote(`deploy-all: ${d.name} failed — continuing (${WHY[e.message] || e.message})`);
      }
    }
    setDeployAllRunning(false);
    setAnnounce(`Deploy all finished: ${okCount} up, ${failed.length} failed`);
    setNote(failed.length
      ? `Deploy all: ${okCount} up, ${failed.length} failed (${failed.join(", ")}). Check the failed demo's Details for the reason.`
      : `Deploy all: all ${okCount} demos are up.`);
    load(true);
  }

  // Stop all: stop every up demo, serially. Skips the shelf itself (stopping the
  // shelf from the shelf would take the page down mid-run).
  const [stopAllRunning, setStopAllRunning] = useState(false);
  async function stopAll() {
    if (!data || stopAllRunning) return;
    const targets = data.demos.filter((d) => !d.isShelf && d.status?.state === "up" && d.canStart);
    if (!targets.length) { setAnnounce("Nothing is running"); setNote("Nothing to stop — no demos are up."); return; }
    setStopAllRunning(true);
    let okCount = 0; const failed = [];
    for (const d of targets) {
      setNote(`stop-all: ${d.name} (${okCount}/${targets.length} done)...`);
      try {
        await call(`/api/demos/${encodeURIComponent(d.id)}/stop`, "POST");
        okCount += 1;
      } catch (e) {
        failed.push(d.name);
        setNote(`stop-all: ${d.name} failed — continuing (${WHY[e.message] || e.message})`);
      }
    }
    setStopAllRunning(false);
    setAnnounce(`Stop all finished: ${okCount} stopped, ${failed.length} failed`);
    setNote(failed.length
      ? `Stop all: ${okCount} stopped, ${failed.length} failed (${failed.join(", ")}).`
      : `Stop all: all ${okCount} demos stopped. The shelf stays up.`);
    load(true);
  }

  // Restore last set: start the demos that were running before the machine restarted,
  // most recent set first (the server caps and orders them). Skips the shelf itself.
  const [restoreRunning, setRestoreRunning] = useState(false);
  async function restoreLast() {
    if (!data || restoreRunning) return;
    setRestoreRunning(true);
    setNote("restore: starting the last-running set...");
    try {
      const last = await call("/api/last-running");
      const ids = last.ids || [];
      if (!ids.length) { setNote("restore: nothing was running before the restart."); setRestoreRunning(false); return; }
      let okCount = 0; const failed = [];
      for (const id of ids) {
        const name = data.demos.find((d) => d.id === id)?.name || id;
        setNote(`restore: ${name} (${okCount}/${ids.length} done)...`);
        try {
          await call(`/api/demos/${encodeURIComponent(id)}/start`, "POST");
          okCount += 1;
        } catch (e) {
          failed.push(name);
          setNote(`restore: ${name} failed — continuing (${WHY[e.message] || e.message})`);
        }
      }
      setAnnounce(`Restore finished: ${okCount} started, ${failed.length} failed`);
      setNote(failed.length
        ? `Restore: ${okCount} started, ${failed.length} failed (${failed.join(", ")}).`
        : `Restore: all ${okCount} demos started.`);
      load(true);
    } catch (e) {
      setNote(`restore failed (${WHY[e.message] || e.message})`);
    }
    setRestoreRunning(false);
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
    const c = Object.fromEntries(BUCKETS.map((b) => [b.id, 0]));
    for (const i of items) c[i.bucket] = (c[i.bucket] || 0) + 1;
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
      window.history.replaceState(null, "", p.toString() ? `?${p}` : window.location.pathname);
    } catch { /* the address is a convenience */ }
  }, [text, picked]);

  const toggleTag = useCallback((id) => setPicked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);

  // Ping products dropdown: a single-select view over the picked tags restricted to the
  // "product" group. Choosing a product replaces any previously picked product tag (the
  // group is OR), and "all" clears them; tags from other groups are untouched.
  const productGroup = tagGroups.find((g) => g.id === "product");
  const productPick = productGroup ? productGroup.tags.find((t) => picked.has(t.id))?.id ?? "" : "";
  const setProductPick = useCallback((id) => setPicked((prev) => {
    if (!productGroup) return prev;
    const n = new Set(prev);
    for (const t of productGroup.tags) n.delete(t.id);
    if (id) n.add(id);
    return n;
  }), [productGroup]);

  // Within one tag group the picked tags are alternatives (OR); across groups they all have to hold (AND).
  const passesBase = (i) => {
    const q = text.trim().toLowerCase();
    return (where === "all" || i.where === where) &&
      (!q || [i.name, i.catalogId, ...(i.alsoCatalogIds || []), i.description, ...(i.tags || []).flatMap((t) => [t, tagInfo.get(t)?.label])].some((f) => (f || "").toLowerCase().includes(q)));
  };
  const passesTags = (i, skip) => tagGroups.every((g) => {
    if (g.id === skip) return true;
    const mine = g.tags.filter((t) => picked.has(t.id));
    return !mine.length || mine.some((t) => i.tags?.includes(t.id));
  });
  const shown = useMemo(() => items.filter((i) => passesBase(i) && passesTags(i)), [items, where, text, picked, tagGroups]); // eslint-disable-line react-hooks/exhaustive-deps
  // How many cards each chip would give, with every other filter (and the other tag groups) applied.
  const tagCounts = useMemo(() => {
    const out = {};
    for (const g of tagGroups) {
      const pool = items.filter((i) => passesBase(i) && passesTags(i, g.id));
      for (const t of g.tags) out[t.id] = pool.filter((i) => i.tags?.includes(t.id)).length;
    }
    return out;
  }, [items, where, text, picked, tagGroups]); // eslint-disable-line react-hooks/exhaustive-deps

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
          <p className="top__sub">Every Ping demo you can run on your laptop. Green is up. Grey is waiting for you to start it.{releaseVersion && <span className="top__version"> · v{releaseVersion}</span>}</p>
        </div>
        <div className="top__tools">
            <ShelfLink />
          <div className="seg" role="group" aria-label="Mode" data-testid="mode">
            <button type="button" aria-pressed={(modeInfo?.source || "mock") === "mock"} onClick={() => selectMode("mock")} data-testid="mode-mock">Mock</button>
            <button type="button" aria-pressed={modeInfo?.source === "real"} disabled={modeInfo?.realAvailable !== true} title={modeInfo?.realAvailable !== true ? modeInfo?.realReason : undefined} onClick={() => selectMode("real")} data-testid="mode-real">Real</button>
          </div>
          <label className="inline">Theme
            <select value={theme} onChange={(e) => setTheme(e.target.value)} data-testid="theme">
              {THEMES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </label>
          <button type="button" aria-pressed={present} onClick={() => setPresent((p) => !p)}>Present</button>
          <button type="button" onClick={restoreLast} disabled={busy || restoreRunning || stopAllRunning || deployAllRunning} aria-busy={restoreRunning || undefined} title="Starts the demos that were running before the last restart (up to 10, most recent set)">
            {restoreRunning && <span className="spin" aria-hidden="true" />}Restore last set
          </button>
          <button type="button" onClick={stopAll} disabled={busy || stopAllRunning || deployAllRunning} aria-busy={stopAllRunning || undefined} title="Stops every running demo; the shelf stays up">
            {stopAllRunning && <span className="spin" aria-hidden="true" />}Stop all
          </button>
          <button type="button" onClick={deployAll} disabled={busy || deployAllRunning || stopAllRunning} aria-busy={deployAllRunning || undefined}>
            {deployAllRunning && <span className="spin" aria-hidden="true" />}Deploy all
          </button>
          <button type="button" onClick={() => load(true)}>Refresh</button>
        </div>
      </header>
      <main className="room">
        <div className="sr" role="status" aria-live="polite">{announce}</div>
        {notesOpen && releases && (
          <div className="note" data-state="info" role="region" aria-label="Release notes">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <strong>What's new — {releaseVersion}</strong>
              <button type="button" aria-label="Close release notes" onClick={dismissNotes}>Close</button>
            </div>
            <div style={{ margin: "8px 0 0" }} dangerouslySetInnerHTML={{ __html: mdToNodes(releases.notes.replace(/^##\s+.+\n/, "")) }} />
            <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <code style={{ fontSize: "0.85em", wordBreak: "break-all" }}>{releases.updateCommand}</code>
              <button type="button" onClick={() => { copyText(releases.updateCommand); setAnnounce("Update command copied"); }}>Copy</button>
            </div>
            <p style={{ marginTop: 6, marginBottom: 0 }}>Run it in a terminal to get these updates. Safe to re-run. This panel stays closed until the next release.</p>
          </div>
        )}
        {updateNotice && (
          <div className="note" data-state="warn" role="status">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <strong>Updates available.</strong>
              <button type="button" aria-label="Dismiss update banner" onClick={() => { setUpdateNotice(null); dismissNotes(); }}>Close</button>
            </div>
            <div dangerouslySetInnerHTML={{ __html: mdToNodes(updateNotice.notice) }} style={{ marginTop: 4 }} />
            {/* One update command on screen at a time: the What's-new panel owns it
                while open; the banner shows its own copy only when the panel is closed. */}
            {!notesOpen && (
              <>
                <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <code style={{ fontSize: "0.85em", wordBreak: "break-all" }}>{updateNotice.updateCommand}</code>
                  <button type="button" onClick={() => { copyText(updateNotice.updateCommand); setAnnounce("Update command copied"); }}>Copy</button>
                </div>
                <p style={{ marginTop: 6, marginBottom: 0 }}>Run it in a terminal — it updates the demos and keeps everything else. Safe to re-run.</p>
              </>
            )}
          </div>
        )}
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
              <span type="button" className="chip" data-state="all">
                <b>{items.length}</b> All
              </span>
              {BUCKETS.map((b) => (
                <span key={b.id} className="chip" data-state={b.id}>
                  <b>{counts[b.id] || 0}</b> {b.label}
                </span>
              ))}
            </section>
            <form className="filters" role="search" onSubmit={(e) => e.preventDefault()}>
              <label>Search<input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, id, description or tag" /></label>
              <div role="group" aria-label="Where it runs" className="filters__where">
                {WHERES.map(([v, label]) => (
                  <button key={v} type="button" className="chip" aria-pressed={where === v} onClick={() => setWhere(v)}>{label}</button>
                ))}
              </div>
              {productGroup && (
                <label>Ping products
                  <select value={productPick} onChange={(e) => setProductPick(e.target.value)}>
                    <option value="">All products</option>
                    {productGroup.tags.map((t) => (
                      <option key={t.id} value={t.id} disabled={!picked.has(t.id) && (tagCounts[t.id] ?? 0) === 0}>{t.label}</option>
                    ))}
                  </select>
                </label>
              )}
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
