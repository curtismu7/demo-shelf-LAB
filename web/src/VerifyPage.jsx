import { useCallback, useEffect, useMemo, useState } from "react";
import VerifyMark from "./components/VerifyMark.jsx";

// The Verification page (#/verify): one row per registered demo, a status (the server's list: Not checked, In progress, Verified), a short
// note, and Save. Saves go to this machine (PUT /api/verification/:id); `npm run verification:publish` ships them to everyone.
// The statuses, their words, their meanings and the note limit all come from the server (verificationInfo), not from this file.

const WHY = {
  "agent-not-running": "the start agent is not running. In the demo-shelf-LAB folder run: npm run agent",
  "agent-token-rejected": "the start agent rejected the shelf's token. Restart the shelf with: npm run docker",
  "agent-bad-reply": "the start agent gave an answer the shelf could not read. Restart it: npm run agent",
  "not-found": "the start agent is older than this page and cannot save marks. Restart it: npm run agent",
  "bad-note": "the note is too long or has a line break",
  "bad-status": "that status is not one the shelf knows",
  "unknown-demo": "that demo is not registered on this shelf",
  "bad-origin": "the request did not come from this page",
};

async function getShelf() {
  const res = await fetch("/api/shelf");
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function saveMark(id, input) {
  const res = await fetch(`/api/verification/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.mark;
}

const current = (d) => ({ status: d.verification?.status ?? "none", note: d.verification?.note ?? "" });

function Row({ demo, info, editable, draft, saving, message, onChange, onSave }) {
  const cur = current(demo);
  const want = draft ?? cur;
  const dirty = want.status !== cur.status || (want.status !== "none" && want.note !== cur.note);
  const noteId = `note-${demo.id}`;
  return (
    <li className="vrow" data-dirty={dirty || undefined}>
      <div className="vrow__who">
        <b>{demo.name}</b>
        <span className="vrow__id mono">{demo.id}</span>
        <VerifyMark mark={demo.verification} note={false} />
      </div>
      <div className="seg" role="group" aria-label={`Status for ${demo.name}`}>
        {info.statuses.map((s) => (
          <button key={s.id} type="button" data-mark={s.id} aria-pressed={want.status === s.id} disabled={!editable || saving} title={s.meaning} onClick={() => onChange(demo.id, { ...want, status: s.id })}>{s.label}</button>
        ))}
      </div>
      <label className="vrow__note" htmlFor={noteId}>Note
        <input id={noteId} type="text" value={want.status === "none" ? "" : want.note} maxLength={info.noteMax} disabled={!editable || saving || want.status === "none"} placeholder={want.status === "none" ? "No note while not checked" : "A short note for users"} onChange={(e) => onChange(demo.id, { ...want, note: e.target.value })} />
      </label>
      <div className="vrow__save">
        <button type="button" className="primary" disabled={!editable || !dirty || saving} aria-busy={saving || undefined} onClick={() => onSave(demo.id, want)}>
          {saving && <span className="spin" aria-hidden="true" />}Save<span className="sr"> {demo.name}</span>
        </button>
        <span className="vrow__msg" role="status" data-state={message?.error ? "error" : undefined}>{message?.text || ""}</span>
      </div>
    </li>
  );
}

export default function VerifyPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState(null);
  const [messages, setMessages] = useState({});
  const [text, setText] = useState("");
  const [filter, setFilter] = useState("all");

  // The shelf's saved theme, so this page matches the one the person just came from.
  useEffect(() => {
    try {
      const t = window.localStorage.getItem("shelf-theme");
      if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    } catch { /* the theme is a convenience */ }
  }, []);

  useEffect(() => { getShelf().then(setData).catch((e) => setError(e.message)); }, []);

  const change = useCallback((id, want) => { setDrafts((d) => ({ ...d, [id]: want })); setMessages((m) => ({ ...m, [id]: null })); }, []);
  const save = useCallback(async (id, want) => {
    setSaving(id);
    try {
      const mark = await saveMark(id, { status: want.status, note: want.status === "none" ? "" : want.note.trim() });
      setData((d) => ({ ...d, demos: d.demos.map((x) => (x.id === id ? { ...x, verification: mark } : x)) }));
      setDrafts((d) => { const { [id]: _gone, ...rest } = d; return rest; });
      setMessages((m) => ({ ...m, [id]: { text: "Saved" } }));
    } catch (e) {
      setMessages((m) => ({ ...m, [id]: { error: true, text: `Not saved: ${WHY[e.message] || e.message}` } }));
    }
    setSaving(null);
  }, []);

  const info = data?.verificationInfo;
  const demos = useMemo(() => (data?.demos || []).slice().sort((a, b) => a.name.localeCompare(b.name)), [data]);
  const counts = useMemo(() => {
    const c = { all: demos.length };
    for (const s of info?.statuses || []) c[s.id] = 0;
    for (const d of demos) c[current(d).status] += 1;
    return c;
  }, [demos, info]);
  const q = text.trim().toLowerCase();
  const shown = demos.filter((d) => (filter === "all" || current(d).status === filter) && (!q || [d.name, d.id].some((f) => f.toLowerCase().includes(q))));

  return (
    <>
      <header className="top">
        <div className="top__name">
          <h1>Verification<span className="top__dot">.</span></h1>
          <p className="top__sub">Mark each demo Verified or In progress, with a short note. The mark shows on its tile on the shelf.</p>
        </div>
        <div className="top__tools">
          <a className="top__link" href="#/">Back to the shelf</a>
        </div>
      </header>
      <main className="room">
        {error && <div className="note" data-state="error" role="alert">Cannot reach the shelf server ({error}).</div>}
        {!data && !error && <p className="howto" role="status">Loading demos…</p>}
        {data && info && (
          <>
            {!data.verificationEditable && (
              <div className="note" data-state="warn" role="status">Saving is off on this shelf: it is not listening on loopback, so Start / Stop and this page are read-only.</div>
            )}
            <div className="note" role="region" aria-label="How marks work">
              <ul className="note__list">
                {info.statuses.filter((s) => s.id !== "none").map((s) => <li key={s.id}><b>{s.label}.</b> {s.meaning}</li>)}
                <li>The note is shown with the mark, up to {info.noteMax} characters.</li>
                <li>A mark you save here is stored on this machine and shows as "Set on this machine". To ship your marks to everyone, run <code className="mono">npm run verification:publish</code> in the shelf folder, then commit <code className="mono">data/verification.json</code> in a pull request.</li>
              </ul>
            </div>
            <section className="lights" aria-label="Summary by mark">
              <button type="button" className="chip" data-state="all" aria-pressed={filter === "all"} onClick={() => setFilter("all")}><b>{counts.all}</b> All</button>
              {info.statuses.map((s) => (
                <button key={s.id} type="button" className="chip" data-mark={s.id} aria-pressed={filter === s.id} disabled={filter !== s.id && !counts[s.id]} onClick={() => setFilter(filter === s.id ? "all" : s.id)}><b>{counts[s.id]}</b> {s.label}</button>
              ))}
            </section>
            <form className="filters" role="search" onSubmit={(e) => e.preventDefault()}>
              <label>Search<input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name or id" /></label>
            </form>
            {shown.length === 0 && <p className="howto" role="status">No demos match.</p>}
            <ul className="vlist" aria-label="Demos">
              {shown.map((d) => (
                <Row key={d.id} demo={d} info={info} editable={Boolean(data.verificationEditable)} draft={drafts[d.id]} saving={saving === d.id} message={messages[d.id]} onChange={change} onSave={save} />
              ))}
            </ul>
          </>
        )}
      </main>
    </>
  );
}
