import { Fragment, useEffect, useRef, useState } from "react";
import { cloneCommand, installState, NOT_BUILT, NOT_INSTALLED_HINT } from "./install.js";
import { LABELS, HINTS } from "./status.js";

export function StatusLight({ state }) {
  return <span className="light" data-state={state}>{LABELS[state] || state}</span>;
}

export const isUp = (state) => state !== "down" && state !== "planned";
export const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : null);

const MAX_PILLS = 6;

function TagPills({ item, tagInfo, picked, onTag }) {
  const known = (item.tags || []).filter((t) => tagInfo?.has(t));
  if (!known.length) return null;
  return (
    <ul className="tag-pills" aria-label="Tags">
      {known.slice(0, MAX_PILLS).map((t) => (
        <li key={t}>
          <button type="button" className="tag-pill" aria-pressed={picked?.has(t) || false} title={tagInfo.get(t).hint} onClick={() => onTag?.(t)}>{tagInfo.get(t).label}</button>
        </li>
      ))}
      {known.length > MAX_PILLS && <li className="tag-more">+{known.length - MAX_PILLS} more in Details</li>}
    </ul>
  );
}

// "Not installed" next to a Copy button for the clone command. Copy runs inside the click; if the browser refuses, the command is
// shown as text and selected so Ctrl/Cmd+C finishes the job.
function CloneCopy({ name, command }) {
  const [state, setState] = useState(null); // null | "copied" | "blocked"
  const codeRef = useRef(null);
  useEffect(() => {
    if (state !== "copied") return undefined;
    const t = setTimeout(() => setState(null), 2500);
    return () => clearTimeout(t);
  }, [state]);
  useEffect(() => {
    if (state !== "blocked" || !codeRef.current) return;
    try {
      const range = document.createRange();
      range.selectNodeContents(codeRef.current);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* the text is still on screen */ }
  }, [state]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setState("copied");
    } catch {
      setState("blocked");
    }
  }
  return (
    <>
      <button type="button" onClick={copy}>Copy clone command<span className="sr"> for {name}</span></button>
      <span className="box__copied" role="status">{state === "copied" ? "Copied" : ""}</span>
      {state === "blocked" && <code className="box__clone mono" ref={codeRef}>{command}</code>}
    </>
  );
}

// Copy start command, with a visible answer next to it (the live-region announcement alone is invisible).
function StartCopy({ item, label, onCopy }) {
  const [state, setState] = useState(null); // null | "copied" | "blocked"
  useEffect(() => {
    if (!state) return undefined;
    const t = setTimeout(() => setState(null), 2500);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <>
      <button type="button" onClick={async () => setState((await onCopy(item)) ? "copied" : "blocked")}>Copy start command<span className="sr"> for {label}</span></button>
      <span className="box__copied" aria-hidden="true" data-state={state || undefined}>{state === "copied" ? "\u2713 Copied" : state === "blocked" ? "Blocked: see Details" : ""}</span>
    </>
  );
}

// Copy the app's URL, offered when the app is down (Open only renders when up).
function UrlCopy({ item, label }) {
  const [state, setState] = useState(null); // null | "copied" | "blocked"
  useEffect(() => {
    if (!state) return undefined;
    const t = setTimeout(() => setState(null), 2500);
    return () => clearTimeout(t);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.url);
      setState("copied");
    } catch {
      setState("blocked");
    }
  };
  return (
    <>
      <button type="button" onClick={copy}>Copy URL<span className="sr"> for {label}</span></button>
      <span className="box__copied" aria-hidden="true" data-state={state || undefined}>{state === "copied" ? "\u2713 Copied" : state === "blocked" ? "Blocked" : ""}</span>
      {state === "blocked" && <code className="box__clone mono" title="The URL Open goes to">{item.url}</code>}
    </>
  );
}

const PING_LABELS = {
  pingfederate: "PingFederate",
  pinggateway: "PingGateway",
  "privilege-gateway": "Privilege Agent Gateway",
  pingone: "PingOne",
  "pingone-privilege": "PingOne Privilege",
};

// Rule 20: shared Ping products this demo needs, and whether each is shared-and-healthy.
// Only shown when something is not ready: a row of green pills is noise.
function PingProducts({ products, live }) {
  const problems = products.filter((p) => p.state !== "ready");
  if (!problems.length) return null;
  const say = (p) => {
    const name = PING_LABELS[p.product] || p.product;
    if (p.state === "not-configured") return `${name}: not configured in the shared env file`;
    if (p.state === "down") return `${name}: no shared instance running`;
    if (p.state === "unhealthy") return `${name}: shared instance is up but not healthy`;
    return `${name}: state unknown`;
  };
  return (
    <p className="box__install box__ping" data-state="warn">
      <span className="box__tag">Needs shared Ping</span>{" "}
      <ul className="box__pinglist">
        {problems.map((p) => (
          <li key={p.product}>{say(p)}{live ? "" : " (the app is down anyway)"}</li>
        ))}
      </ul>
    </p>
  );
}

export function Card({ item, startEnabled, present, busy, activeAction, starting, onAction, onCopy, onDetails, tagInfo, picked, onTag }) {
  const s = item.status;
  if (item.planned) {
    return (
      <article className="box" data-planned="true" data-kind={item.kind || "none"} aria-label={`${item.name} (planned)`}>
        <h3>{item.name}</h3>
        <p className="box__meta">{item.id} · {item.kind || "Item"} · wave {item.wave ?? "?"}</p>
        <StatusLight state="planned" />
        <TagPills item={item} tagInfo={tagInfo} picked={picked} onTag={onTag} />
        <div className="box__actions">
          <button type="button" onClick={() => onDetails(item)}>Details<span className="sr"> for {item.name}</span></button>
        </div>
      </article>
    );
  }
  const place = item.where === "mock" ? "Mock" : "Installed";
  const label = `${item.name} (${place})`;
  const inst = present ? "unknown" : installState(item, isUp(s.state));
  // Started, and the app has not answered its health check yet: show Starting with a spinner instead of Down.
  const waiting = !present && starting === "starting" && !isUp(s.state);
  const stalled = !present && starting === "stalled" && !isUp(s.state);
  const clone = inst === "not-installed" ? cloneCommand(item.repo) : null;
  return (
    <article className="box" data-state={s.state} data-kind={item.kind || "none"} data-install={inst} aria-label={label}>
      <h3>{item.name}</h3>
      <span className="box__place">{place}{item.isNew && <span className="box__new" title={item.addedAt ? `Added ${item.addedAt}` : undefined}>New</span>}</span>
      <StatusLight state={waiting ? "starting" : s.state} />
      <p className="box__desc">{item.description}</p>
      <TagPills item={item} tagInfo={tagInfo} picked={picked} onTag={onTag} />
      <p className="box__meta">
        {item.catalogId ?? "unlisted"} · {item.kind || "Item"}
        {s.runtime ? ` · ${s.runtime}` : ""}
      </p>
      <p className="box__meta">
        {s.lastChecked ? `Checked ${clock(s.lastChecked)}` : "Not checked"}
        {s.latencyMs != null && s.state !== "down" ? ` · ${s.latencyMs} ms` : ""}
      </p>
      {waiting && <p className="box__install" role="status"><span className="spin" aria-hidden="true" />Starting: waiting for {item.name} to answer. The first start can take a few minutes.</p>}
      {stalled && <p className="box__install">Started, but it is still not answering after 2 minutes. Check its container logs (docker compose logs).</p>}
      {!waiting && !stalled && inst === "not-installed" && <p className="box__install"><span className="box__tag">Not installed</span> {NOT_INSTALLED_HINT}</p>}
      {!waiting && !stalled && inst === "not-built" && <p className="box__install">{NOT_BUILT}.</p>}
      {!waiting && !stalled && inst === "stopped" && <p className="box__install">Installed, not answering.</p>}
      {(item.pingProducts || []).length > 0 && <PingProducts products={item.pingProducts} live={item.status?.state !== "down"} />}
      <div className="box__actions">
        {!present && startEnabled && item.where !== "mock" && (() => {
          const up = isUp(s.state);
          const noCompose = "No compose file is registered for this demo";
          return (
            <>
              <button type="button" className={up ? undefined : "primary"} aria-busy={activeAction === "start" || waiting || undefined} disabled={busy || waiting || !item.canStart || up || inst === "not-installed"} title={!item.canStart ? noCompose : up ? "Already running" : inst === "not-installed" ? NOT_INSTALLED_HINT : inst === "not-built" ? NOT_BUILT : undefined} onClick={() => onAction(item.id, "start")}>{(activeAction === "start" || waiting) && <span className="spin" aria-hidden="true" />}Start<span className="sr"> {label}</span></button>
              <button type="button" aria-busy={activeAction === "stop" || undefined} disabled={busy || !item.canStart || !up} title={!item.canStart ? noCompose : up ? `Stops only ${item.name}; the shelf keeps running` : "Not running"} onClick={() => onAction(item.id, "stop")}>{activeAction === "stop" && <span className="spin" aria-hidden="true" />}Stop<span className="sr"> {label}</span></button>
              {item.repo && !up && <button type="button" className={up ? undefined : "primary"} aria-busy={activeAction === "deploy" || undefined} disabled={busy || waiting} title={inst === "not-installed" ? "Clones the repo, then starts the app" : "Updates the repo (fast-forward only), then starts the app"} onClick={() => onAction(item.id, "deploy")}>{activeAction === "deploy" && <span className="spin" aria-hidden="true" />}Deploy<span className="sr"> {label}</span></button>}
            </>
          );
        })()}
        {isUp(s.state) && (
          <>
            {/* Owner rule: users always get the lab-proxy domain, never a loopback URL.
                Labs without a proxy route fall back to their direct URL. */}
            <a className="box__open" href={item.proxyUrl || item.url} target="_blank" rel="noopener noreferrer" title={item.proxyUrl ? "Opens through the lab-proxy (local.ping-devops.com)" : undefined}>Open<span className="sr"> {label} in a new tab</span></a>
            <span className="box__url mono" title="The URL Open goes to">{item.proxyUrl || item.url}</span>
          </>
        )}
        {/* Rule 20 UX: read the source before deploying — the Repo link renders whenever a repo is registered, up or not. */}
        {item.repo && <a className="box__open box__repo" href={item.repo} target="_blank" rel="noopener noreferrer" title="The app's source on GitHub">Repo<span className="sr"> {label} on GitHub</span></a>}
        {clone && <CloneCopy name={label} command={clone} />}
        {item.startCommand && <StartCopy item={item} label={label} onCopy={onCopy} />}
        {!isUp(s.state) && item.url && <UrlCopy item={item} label={label} />}
        <button type="button" onClick={() => onDetails(item)}>Details<span className="sr"> for {label}</span></button>
      </div>
    </article>
  );
}

export function Drawer({ item, present, onClose, closeRef, tagGroups = [] }) {
  const s = item.status;
  const hint = HINTS[s.state];
  return (
    <aside className="drawer" role="dialog" aria-label={`${item.name} details`} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="drawer__head">
        <h2>{item.name}{item.isNew && <span className="box__new">New</span>}</h2>
        <button type="button" ref={closeRef} onClick={onClose}>Close</button>
      </div>
      <p><StatusLight state={s.state} /></p>
      <dl>
        <dt>What this state means</dt>
        <dd>{hint.means}</dd>
        <dt>Fix</dt>
        <dd>{hint.fix}</dd>
        {s.reason && (<><dt>Reason reported</dt><dd>{s.reason}</dd></>)}
        {s.demo?.version && (<><dt>Version</dt><dd>{s.demo.version}</dd></>)}
        {!item.planned && (<><dt>Registered URL</dt><dd className="mono">{item.url}</dd></>)}
        {!item.planned && item.addedAt && (<><dt>Added to the shelf</dt><dd>{item.addedAt}</dd></>)}
        {!item.planned && item.repo && (<><dt>Repo</dt><dd className="mono">{item.repo}</dd></>)}
        {!present && item.install && item.install !== "unknown" && !item.planned && (<><dt>On this machine</dt><dd>{item.install === "not-installed" ? "Not installed" : item.imagesBuilt === false ? NOT_BUILT : "Installed"}</dd></>)}
        {!present && item.install === "not-installed" && cloneCommand(item.repo) && (<><dt>Clone command</dt><dd className="mono">{cloneCommand(item.repo)}</dd></>)}
        {!present && item.composeFile && (<><dt>Compose file</dt><dd className="mono">{item.composeFile}</dd></>)}
        {item.startCommand && (<><dt>Start command</dt><dd className="mono">{item.startCommand}</dd></>)}
        {item.tags?.length > 0 && tagGroups.map((g) => {
          const mine = g.tags.filter((t) => item.tags.includes(t.id));
          return mine.length ? (<Fragment key={g.id}><dt>{g.label}</dt><dd>{mine.map((t) => t.label).join(", ")}</dd></Fragment>) : null;
        })}
        <dt>Plan row</dt>
        <dd>{item.catalogId ?? item.id}, wave {item.wave ?? "?"}, in standalone-demo-family-plan.md</dd>
      </dl>
    </aside>
  );
}
