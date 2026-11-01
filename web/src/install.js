// What the card says about "is it on this machine". The server decides (item.install, item.imagesBuilt); this only words it.
// Anything that is not a clean github.com repo address gets no clone command: the command is built from the checked field, as text.
const REPO = /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export const cloneCommand = (repo) => {
  if (typeof repo !== "string") return null;
  const bare = repo.endsWith(".git") ? repo.slice(0, -4) : repo;
  return REPO.test(bare) && !bare.endsWith(".git") && !/\/\.\.?(\/|$)/.test(bare.slice(8)) ? `git clone ${bare}.git` : null;
};

export const NOT_BUILT = "Installed, not built yet: Start builds it (can take a few minutes)";
export const NOT_INSTALLED_HINT = "Not installed on this machine. Get the repo next to the shelf, then press Refresh.";

// 'none' (planned, mock) | 'running' | 'not-installed' | 'not-built' | 'stopped' | 'unknown'. Unknown behaves exactly like before this existed.
export function installState(item, up) {
  if (item.planned || item.where === "mock") return "none";
  if (up) return "running";
  if (item.install === "not-installed") return "not-installed";
  if (item.install === "installed") return item.imagesBuilt === false ? "not-built" : "stopped";
  return "unknown";
}
