export const LABELS = {
  ready: "Ready",
  "needs-setup": "Needs setup",
  broken: "Broken",
  unknown: "Unknown",
  "up-no-contract": "Up (no health contract)",
  down: "Down",
  planned: "Planned",
};

// Summary order and the status filter options.
export const STATES = ["ready", "needs-setup", "broken", "down", "up-no-contract", "unknown", "planned"];

export const HINTS = {
  ready: { means: "The demo answered its health check and reports it is ready.", fix: "Nothing to do." },
  "needs-setup": { means: "The demo is running and says setup is incomplete (for example a missing tenant value).", fix: "Open it and run its doctor or setup page, then refresh." },
  broken: { means: "The demo is running and reports it is broken.", fix: "Check its container logs (docker compose logs) and its doctor output, fix, then refresh." },
  down: { means: "Nothing answered at the registered URL, or it answered with an error.", fix: "Copy the start command and run it, or check that the registered port is the one the demo uses." },
  "up-no-contract": { means: "The page loads but the demo has no /api/health, so the shelf cannot tell whether it is configured.", fix: "It may work fine. Adding GET /api/health (demo-health/1) turns this into a real status." },
  unknown: { means: "The demo answered, but its health reply was off-contract or oversized, or it reported unknown.", fix: "Check that GET /api/health returns demo-health/1 JSON." },
  planned: { means: "Not built yet. It is on the plan but has no registered demo.", fix: "Nothing to do until it ships. Register it in .data/demos.local.json when it exists." },
};
