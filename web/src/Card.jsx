import { Fragment } from "react";
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

export function Card({ item, startEnabled, present, busy, onAction, onCopy, onDetails, tagInfo, picked, onTag }) {
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
  return (
    <article className="box" data-state={s.state} data-kind={item.kind || "none"} aria-label={label}>
      <h3>{item.name}</h3>
      <span className="box__place">{place}</span>
      <StatusLight state={s.state} />
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
      <div className="box__actions">
        {isUp(s.state) && <a className="box__open" href={item.url} target="_blank" rel="noopener noreferrer">Open<span className="sr"> {label} in a new tab</span></a>}
        {item.startCommand && <button type="button" onClick={() => onCopy(item)}>Copy start command<span className="sr"> for {label}</span></button>}
        {!present && startEnabled && item.canStart && (
          <>
            <button type="button" disabled={busy} onClick={() => onAction(item.id, "start")}>Start<span className="sr"> {label}</span></button>
            <button type="button" disabled={busy} onClick={() => onAction(item.id, "stop")}>Stop<span className="sr"> {label}</span></button>
          </>
        )}
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
        <h2>{item.name}</h2>
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
