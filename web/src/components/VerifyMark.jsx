import React from "react";

// The one badge for a verification mark ({ status, label, note, updatedAt, source } from /api/shelf). The shelf card, the Details drawer
// and the Verification page all render it, so a change here (the tick, the colours in styles.css, the wording of the note line) changes
// every place at once. The words ("Verified", "In progress") come from the server's single definition, never from here.
// A tile with no mark, or one set to "none", renders nothing.
export default function VerifyMark({ mark, note = true, className = "" }) {
  if (!mark || mark.status === "none") return null;
  const local = mark.source === "local";
  const title = [mark.updatedAt && `Marked ${mark.updatedAt}`, local && "set on this machine, not shipped with the shelf"].filter(Boolean).join(", ");
  return (
    <div className={`verify ${className}`.trim()} data-status={mark.status} title={title || undefined}>
      <span className="verify__badge">
        <svg className="verify__icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <circle className="verify__ring" cx="8" cy="8" r="7" />
          <path className="verify__tick" d="M4.6 8.4l2.3 2.3 4.5-4.8" />
        </svg>
        {mark.label}
      </span>
      {note && mark.note && <span className="verify__note">{mark.note}</span>}
      {note && local && <span className="verify__local">Set on this machine</span>}
    </div>
  );
}
