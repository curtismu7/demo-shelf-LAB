import { useEffect, useRef } from "react";

// Side drawer that explains every way to start a demo. Same look and keys as the
// details drawer: Escape or Close shuts it, focus goes to Close on open.
export default function HelpDrawer({ onClose }) {
  const closeRef = useRef(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  return (
    <aside className="drawer" role="dialog" aria-label="How to start a demo" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="drawer__head">
        <h2>How to start a demo</h2>
        <button type="button" ref={closeRef} onClick={onClose}>Close</button>
      </div>

      <h3 className="help__step">On the shelf</h3>
      <p>Press <strong>Start</strong> on a card. The shelf asks the start agent to run it, then the light turns green. A card that says Not installed needs its repo cloned first: open <strong>Details</strong> and use the clone command.</p>

      <h3 className="help__step">After a restart</h3>
      <p>Press <strong>Restore last set</strong> in the header. It starts the demos that were running before the restart (up to 10, most recent first). Demos do not come back on their own.</p>

      <h3 className="help__step">From a terminal</h3>
      <p>Run these in the AI-DEMO-Standalone folder:</p>
      <dl className="help__cmds">
        <dt className="mono">scripts/setup.sh --start &lt;lab-dir&gt;</dt>
        <dd>One demo. The lab-dir is its folder under <span className="mono">standalone/</span>, for example <span className="mono">hostile-mcp-LAB</span>.</dd>
        <dt className="mono">scripts/setup.sh --start-top=10</dt>
        <dd>Your 10 most recently used demos.</dd>
        <dt className="mono">scripts/setup.sh --start-all</dt>
        <dd>Every demo at once. Heavy: on a Mac with under 16 GB of RAM start one or ten, not all.</dd>
      </dl>

      <h3 className="help__step">If Start does nothing</h3>
      <ul className="help__list">
        <li>The start agent is not running: in the demo-shelf-LAB folder run <span className="mono">npm run agent</span> and leave it running.</li>
        <li>Docker is not running: open OrbStack.</li>
        <li>Many demos running and the Mac is slow: stop the ones you are not using (<strong>Stop all</strong>), or lower OrbStack's memory in Settings, System.</li>
      </ul>
    </aside>
  );
}
