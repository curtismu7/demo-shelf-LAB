// User-facing status buckets for the shelf (four, per the owner):
//   Running  — the demo answers its health check right now
//   Deployed — cloned/installed on this machine (may be running or stopped; Running is the live subset)
//   Offline  — installed but not answering (stopped, failed, or unhealthy)
//   Not deployed — in GitHub/the catalog but not deployed on this machine (not the same as the What's new filter)
// The server's finer-grained states (ready/broken/needs-setup/…) still drive the
// Details drawer; the shelf summary and filter use these four buckets.
export const BUCKETS = [
  { id: "running",  label: "Running" },
  { id: "deployed", label: "Deployed" },
  { id: "offline",  label: "Offline" },
  { id: "new",      label: "Not deployed" },
];

// Internal states → bucket. 'planned' (in the catalog, not registered) counts as Not deployed.
export const BUCKET_OF_STATE = {
  ready: "running",
  "needs-setup": "running",
  "up-no-contract": "running",
  unknown: "running",
  down: "offline",
  broken: "offline",
  planned: "new",
};

// Kept for the Details drawer labels.
export const LABELS = {
  ready: "Ready",
  "needs-setup": "Needs setup",
  broken: "Broken",
  unknown: "Unknown",
  "up-no-contract": "Up (no health contract)",
  down: "Down",
  planned: "Planned",
  starting: "Starting",
};

export const HINTS = {
  ready: { means: "The demo answered its health check and reports it is ready.", fix: "Nothing to do." },
  "needs-setup": { means: "The demo is running and says setup is incomplete (for example a missing tenant value).", fix: "Open it and run its doctor or setup page, then refresh." },
  broken: { means: "The demo is running and reports it is broken.", fix: "Check its container logs (docker compose logs) and its doctor output, fix, then refresh." },
  down: { means: "Nothing answered at the registered URL, or it answered with an error.", fix: "Copy the start command and run it, or check that the registered port is the one the demo uses." },
  "up-no-contract": { means: "The page loads but the demo has no /api/health, so the shelf cannot tell whether it is configured.", fix: "It may work fine. Adding GET /api/health (demo-health/1) turns this into a real status." },
  unknown: { means: "The demo answered, but its health reply was off-contract or oversized, or it reported unknown.", fix: "Check that GET /api/health returns demo-health/1 JSON." },
  planned: { means: "A standalone app that is built or proposed but not registered on this shelf yet.", fix: "Run it once from its folder and it adds itself, or register it in .data/demos.local.json." },
};
