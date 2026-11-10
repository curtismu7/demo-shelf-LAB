import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.jsx";

const st = (state, extra = {}) => ({ state, lastChecked: "2026-10-21T10:00:00Z", latencyMs: 12, ...extra });
const shelf = (over = {}) => ({
  startEnabled: false,
  groups: { A: "Identity", C: "Tokens" },
  demos: [
    { id: "a", name: "Demo A", catalogId: "C1", kind: "Demo", group: "C", wave: 0, description: "token playground", url: "http://localhost:4500", composeFile: "/x/c.yml", startCommand: "docker compose -f /x/c.yml up -d", canStart: true, status: st("ready", { runtime: "offline" }) },
    { id: "b", name: "Demo B", catalogId: "A1", kind: "Tester", group: "A", wave: 1, description: "mfa checks", url: "http://localhost:4501", canStart: false, status: st("down", { reason: "unreachable", latencyMs: 3000 }) },
    { id: "c", name: "Demo C", catalogId: "A2", kind: "Tool", group: "A", wave: 1, description: "plain page", url: "http://localhost:4502", canStart: false, status: st("up-no-contract") },
  ],
  planned: [{ id: "A3", name: "Passwordless", kind: "Demo", group: "A", wave: 3, status: { state: "planned" } }],
  ...over,
});
const cardOf = (name) => within(screen.getByRole("heading", { name }).closest("article"));
const INFO = { source: "mock", realAvailable: false, realReason: "The shelf is a launcher: it has no live mode. It starts, stops and health-checks the other demos, and each of those has its own Mock/Real toggle." };
const mockFetch = (body) => { const f = vi.fn(async (url, init = {}) => {
  if (String(url) === "/api/info") return { ok: true, json: async () => INFO };
  if (String(url) === "/api/mode" && init.method === "POST") {
    const b = JSON.parse(init.body || "{}");
    if (!["mock", "real"].includes(b.source) || Object.keys(b).length !== 1) return { ok: false, json: async () => ({ error: "bad-request", message: 'body must be exactly {source: "mock" or "real"}' }) };
    if (b.source === "real") return { ok: false, json: async () => ({ error: "real-not-available", message: INFO.realReason }) };
    return { ok: true, json: async () => INFO };
  }
  return { ok: true, json: async () => body };
}); vi.stubGlobal("fetch", f); return f; };
beforeEach(() => { window.history.replaceState(null, "", "/"); }); // tests look at every card; the page itself opens on All
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); Object.defineProperty(document, "hidden", { value: false, configurable: true }); window.history.replaceState(null, "", "/"); }); // the filter lives in the address, so each test starts from a clean one

describe("shelf page", () => {
  it("the Mock/Real toggle is in the header: Real is disabled with the launcher's honest reason, and a mock switch reloads", async () => {
    const f = mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    expect(screen.getByTestId("mode-mock")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("mode-real")).toBeDisabled();
    expect(screen.getByTestId("mode-real").getAttribute("title")).toContain("The shelf is a launcher");
    // Already in Mock (the shelf has no live side), so the mock click is a no-op: no POST, no reload.
    fireEvent.click(screen.getByTestId("mode-mock"));
    expect(f.mock.calls.every(([u, i]) => !(u === "/api/mode" && i?.method === "POST"))).toBe(true);
  });
  it("groups cards by catalog group and shows status as text", async () => {
    mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    expect(screen.getByRole("heading", { name: "On your shelf" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Planned · A · Identity/ })).toBeInTheDocument();
    const a = screen.getByText("Demo A").closest("article");
    expect(within(a).getByText("Ready")).toBeInTheDocument();
    expect(within(screen.getByText("Demo B").closest("article")).getByText("Down")).toBeInTheDocument();
    expect(within(screen.getByText("Demo C").closest("article")).getByText("Up (no health contract)")).toBeInTheDocument();
    expect(within(screen.getByText("Passwordless").closest("article")).getByText("Planned")).toBeInTheDocument();
    expect(screen.getByText(/wave 3/)).toBeInTheDocument();
  });
  it("shows summary counts and Open only when the demo is up", async () => {
    mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    const sum = screen.getByRole("region", { name: "Summary by status" });
    expect(within(sum).getByText("Running").closest("span")).toHaveTextContent("2"); // Demo A (ready) + Demo C (up, no contract)
    expect(within(sum).getByText("Offline").closest("span")).toHaveTextContent("1"); // Demo B (down)
    expect(within(sum).getByText("Not deployed").closest("span")).toHaveTextContent("1"); // Passwordless (planned)
    expect(within(sum).queryByText("New")).toBeNull(); // "New" is only the recently-added badge
    expect(within(screen.getByText("Demo A").closest("article")).getByRole("link", { name: /Open/ })).toHaveAttribute("target", "_blank");
    expect(within(screen.getByText("Demo B").closest("article")).queryByRole("link")).toBeNull();
  });
  it("shows the app URL next to Open so the user knows where it goes", async () => {
    mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    const a = screen.getByText("Demo A").closest("article");
    expect(within(a).getByText("http://localhost:4500")).toBeInTheDocument();
  });
  it("Details shows the repo URL when the registry has one, and nothing extra when it does not", async () => {
    mockFetch(shelf({ demos: [{ ...shelf().demos[0], repo: "https://github.com/curtismu7/id-jag-standalone-LAB" }, ...shelf().demos.slice(1)] }));
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.click(within(screen.getByText("Demo A").closest("article")).getByRole("button", { name: /Details/ }));
    const drawer = screen.getByRole("dialog", { name: "Demo A details" });
    expect(within(drawer).getByText("Repo")).toBeInTheDocument();
    expect(within(drawer).getByText("https://github.com/curtismu7/id-jag-standalone-LAB")).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(within(screen.getByText("Demo B").closest("article")).getByRole("button", { name: /Details/ }));
    const drawerB = screen.getByRole("dialog", { name: "Demo B details" });
    expect(within(drawerB).queryByText("Repo")).toBeNull();
  });
  it("offers a Repo link on the card for demos with a repo; the link opens the repo URL", async () => {
    mockFetch(shelf({ startEnabled: true, demos: [{ ...shelf().demos[1], canStart: true, composeFile: "/x/c.yml", repo: "https://github.com/curtismu7/agent-kill-switch-LAB" }, ...shelf().demos.filter((d) => d.id !== "b")] }));
    render(<App />);
    await screen.findByText("Demo B");
    const b = screen.getByText("Demo B").closest("article");
    if (within(b).queryByRole("link", { name: /on GitHub/ }) === null) console.log('DEBUG card html:', b.innerHTML.slice(0, 600));
    const repo = within(b).getByRole("link", { name: /Repo Demo B \(Installed\) on GitHub/ });
    expect(repo).toHaveAttribute("href", "https://github.com/curtismu7/agent-kill-switch-LAB");
    expect(repo).toHaveAttribute("target", "_blank");
    // repo-less demo a: no Repo link on the card
    expect(within(screen.getByText("Demo A").closest("article")).queryByRole("link", { name: /on GitHub/ })).toBeNull();
  });
  it("offers Deploy when the app is not running and a repo is registered; not when running or repo-less", async () => {
    mockFetch(shelf({ startEnabled: true, demos: [{ ...shelf().demos[1], canStart: true, composeFile: "/x/c.yml", repo: "https://github.com/curtismu7/agent-kill-switch-LAB" }, ...shelf().demos.filter((d) => d.id !== "b")] }));
    render(<App />);
    await screen.findByText("Demo B");
    const b = screen.getByText("Demo B").closest("article");
    expect(within(b).getByRole("button", { name: /Deploy/ })).toBeInTheDocument();
    // running demo a: no Deploy
    expect(within(screen.getByText("Demo A").closest("article")).queryByRole("button", { name: /Deploy/ })).toBeNull();
    fireEvent.click(within(b).getByRole("button", { name: /Deploy/ }));
    await waitFor(() => expect(document.querySelector(".note")).not.toBeNull());
    expect(document.querySelector(".note").textContent).toMatch(/deploy done/i);
  });
  it("filters by text and shows the status summary chips", async () => {
    mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "mfa" } });
    expect(screen.queryByText("Demo A")).toBeNull();
    expect(screen.getByText("Demo B")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "" } });
    expect(screen.getByLabelText("Summary by status")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "zzz" } });
    expect(screen.getByText("Nothing matches these filters.")).toBeInTheDocument();
  });
  it("filters by where it runs and tags each card", async () => {
    const base = shelf();
    const mock = { ...base.demos[0], id: "a-mock", where: "mock", url: "https://demos.example.com", startCommand: null, canStart: false };
    mockFetch({ ...base, demos: [{ ...base.demos[0], where: "installed" }, mock, { ...base.demos[1], where: "installed" }] });
    render(<App />);
    await screen.findByText("Demo B");
    const group = screen.getByRole("group", { name: "Where it runs" });
    expect(within(group).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    const cards = screen.getAllByText("Demo A").map((e) => e.closest("article"));
    expect(cards.map((c) => within(c).getByText(/^(Installed|Mock)$/).textContent)).toEqual(["Installed", "Mock"]);
    expect(within(cards[1]).getByRole("link", { name: /Open/ })).toHaveAttribute("href", "https://demos.example.com");
    fireEvent.click(within(group).getByRole("button", { name: "Mock" }));
    expect(screen.getAllByText("Demo A")).toHaveLength(1);
    expect(screen.queryByText("Demo B")).toBeNull();
    expect(screen.queryByText("Passwordless")).toBeNull();
    fireEvent.click(within(group).getByRole("button", { name: "Installed" }));
    expect(screen.getAllByText("Demo A")).toHaveLength(1);
    expect(screen.getByText("Demo B")).toBeInTheDocument();
  });
  it("tells the two copies of a demo apart by accessible name", async () => {
    const base = shelf();
    const mock = { ...base.demos[0], id: "a-mock", where: "mock", url: "https://demos.example.com", startCommand: null, canStart: false };
    mockFetch({ ...base, demos: [{ ...base.demos[0], where: "installed" }, mock] });
    render(<App />);
    await screen.findAllByText("Demo A");
    expect(screen.getByRole("link", { name: "Open Demo A (Installed) in a new tab" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Demo A (Mock) in a new tab" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Demo A (Mock)" })).toBeInTheDocument();
  });
  it("says so when there are no mock copies", async () => {
    mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.click(screen.getAllByRole("button", { name: "Mock" }).find((b) => b.className.includes("chip")));
    expect(screen.getByText("No mock copies yet.")).toBeInTheDocument();
  });
  it("shows both Start and Stop on every installed card, enabling only the one that applies", async () => {
    const body = shelf({ startEnabled: true, agent: "up" });
    body.demos[1].canStart = true;
    mockFetch(body);
    render(<App />);
    await screen.findByRole("heading", { name: "Demo A" });
    const up = cardOf("Demo A");
    expect(up.getByRole("button", { name: /^Stop (?!all)/ })).toBeEnabled();
    expect(up.getByRole("button", { name: /^Stop (?!all)/ })).toHaveAttribute("title", "Stops only Demo A; the shelf keeps running");
    expect(up.getByRole("button", { name: /^Start/ })).toBeDisabled();
    expect(up.getByRole("button", { name: /^Start/ })).toHaveAttribute("title", "Already running");
    const down = cardOf("Demo B");
    expect(down.getByRole("button", { name: /^Start/ })).toBeEnabled();
    expect(down.getByRole("button", { name: /^Stop (?!all)/ })).toBeDisabled();
    expect(down.getByRole("button", { name: /^Stop (?!all)/ })).toHaveAttribute("title", "Not running");
  });
  it("disables both, saying why, when the demo has no compose file", async () => {
    mockFetch(shelf({ startEnabled: true, agent: "up" }));
    render(<App />);
    await screen.findByRole("heading", { name: "Demo C" });
    const c = cardOf("Demo C");
    for (const name of [/^Start/, /^Stop/]) {
      expect(c.getByRole("button", { name })).toBeDisabled();
      expect(c.getByRole("button", { name })).toHaveAttribute("title", "No compose file is registered for this demo");
    }
  });
  it("Stop sends one request, for that demo only", async () => {
    const body = shelf({ startEnabled: true, agent: "up" });
    body.demos[1].canStart = true;
    const f = vi.fn(async (url, init) => ({ ok: true, json: async () => (init?.method === "POST" ? { ok: true } : body) }));
    vi.stubGlobal("fetch", f);
    render(<App />);
    await screen.findByRole("heading", { name: "Demo A" });
    fireEvent.click(cardOf("Demo A").getByRole("button", { name: /^Stop (?!all)/ }));
    expect(await screen.findByText("a: stop done")).toBeInTheDocument();
    const posts = f.mock.calls.filter(([url, init]) => init?.method === "POST" && url.startsWith("/api/demos/")).map(([url]) => url);
    expect(posts).toEqual(["/api/demos/a/stop"]); // the follow-up /api/shelf/refresh is the page reloading, not another demo
  });
  it("explains is-the-shelf in plain words", async () => {
    const body = shelf({ startEnabled: true, agent: "up" });
    vi.stubGlobal("fetch", vi.fn(async (url, init) => (init?.method === "POST" ? { ok: false, json: async () => ({ error: "is-the-shelf" }) } : { ok: true, json: async () => body })));
    render(<App />);
    await screen.findByRole("heading", { name: "Demo A" });
    fireEvent.click(cardOf("Demo A").getByRole("button", { name: /^Stop (?!all)/ }));
    expect(await cardOf("Demo A").findByText(/that entry is the shelf itself/)).toBeInTheDocument();
  });
  it("hides Start and Stop unless the server enables them, on mock cards, and in Present mode", async () => {
    mockFetch(shelf());
    const { unmount } = render(<App />);
    await screen.findByText("Demo A");
    expect(screen.queryByRole("button", { name: /^(Start|Stop) (?!all)/ })).toBeNull();
    unmount();
    const body = shelf({ startEnabled: true, agent: "up" });
    body.demos.push({ id: "m", name: "Demo M", where: "mock", kind: "Demo", group: "C", wave: 0, description: "hosted copy", url: "https://m.example", canStart: false, status: st("ready") });
    mockFetch(body);
    render(<App />);
    await screen.findByRole("heading", { name: "Demo M" });
    expect(cardOf("Demo M").queryByRole("button", { name: /^(Start|Stop) (?!all)/ })).toBeNull();
    expect(cardOf("Demo A").getByRole("button", { name: /^Stop (?!all)/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    expect(document.documentElement.dataset.present).toBe("1");
    expect(screen.queryByRole("button", { name: /^(Start|Stop) (?!all)/ })).toBeNull();
  });
  it("warns when the start agent is down and disables Start", async () => {
    const body = shelf({ startEnabled: true, agent: "down" });
    body.demos[1].canStart = true;
    mockFetch(body);
    render(<App />);
    await screen.findByRole("heading", { name: "Demo B" });
    expect(screen.getByText(/start agent is not running/)).toBeInTheDocument();
    expect(cardOf("Demo B").getByRole("button", { name: /^Start/ })).toBeDisabled();
  });
  it("explains a refused start in plain words", async () => {
    const body = shelf({ startEnabled: true, agent: "up" });
    body.demos[1].canStart = true;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => (init?.method === "POST"
      ? { ok: false, json: async () => ({ error: "agent-not-running" }) }
      : { ok: true, json: async () => body })));
    render(<App />);
    await screen.findByRole("heading", { name: "Demo B" });
    fireEvent.click(cardOf("Demo B").getByRole("button", { name: /^Start/ }));
    expect(await cardOf("Demo B").findByText(/did not run: the start agent is not running\. In the demo-shelf-LAB folder run: npm run agent/)).toBeInTheDocument();
  });
  it("tells you when the agent refuses the token, and keeps Start disabled", async () => {
    const body = shelf({ startEnabled: true, agent: "token-rejected" });
    body.demos[1].canStart = true;
    mockFetch(body);
    render(<App />);
    await screen.findByRole("heading", { name: "Demo B" });
    expect(screen.getByText(/refused the shelf's token/)).toBeInTheDocument();
    expect(cardOf("Demo B").getByRole("button", { name: /^Start/ })).toBeDisabled();
  });
  it("hides the agent warning in Present mode", async () => {
    const body = shelf({ startEnabled: true, agent: "down" });
    body.demos[1].canStart = true;
    mockFetch(body);
    render(<App />);
    await screen.findByText(/start agent is not running/);
    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    expect(screen.queryByText(/start agent is not running/)).toBeNull();
  });
  it.each([
    ["docker-context-not-orbstack", /Docker's context is not OrbStack\. Run: docker context use orbstack/],
    ["compose-file-missing", /its compose file was not found beside the shelf/],
    ["docker-unavailable", /Docker is not running\. Start OrbStack/],
  ])("explains %s in plain words", async (code, text) => {
    const body = shelf({ startEnabled: true, agent: "up" });
    body.demos[1].canStart = true;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => (init?.method === "POST" ? { ok: false, json: async () => ({ error: code }) } : { ok: true, json: async () => body })));
    render(<App />);
    await screen.findByRole("heading", { name: "Demo B" });
    fireEvent.click(cardOf("Demo B").getByRole("button", { name: /^Start/ }));
    expect(await cardOf("Demo B").findByText(text)).toBeInTheDocument();
  });
  it("copies the exact start command", async () => {
    mockFetch(shelf());
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<App />);
    await screen.findByText("Demo A");
    expect(screen.getAllByRole("button", { name: /Copy start command/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Copy start command/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("docker compose -f /x/c.yml up -d"));
    await waitFor(() => expect(screen.getAllByRole("status").map((n) => n.textContent).join("|")).toContain("Copied the start command for Demo A"));
    expect(within(screen.getByText("Demo A").closest("article")).getByText("\u2713 Copied")).toBeInTheDocument(); // visible, not only announced
  });
  it("opens a details drawer with the fix hint, hiding the registry path in Present mode", async () => {
    mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.click(within(screen.getByText("Demo B").closest("article")).getByRole("button", { name: /Details/ }));
    const d = screen.getByRole("dialog", { name: "Demo B details" });
    expect(within(d).getByText(/Nothing answered/)).toBeInTheDocument();
    expect(within(d).getByText("http://localhost:4501")).toBeInTheDocument();
    fireEvent.keyDown(d, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    fireEvent.click(within(screen.getByRole("heading", { name: "Demo A" }).closest("article")).getByRole("button", { name: /Details/ }));
    expect(screen.queryByText("/x/c.yml")).toBeNull();
  });
  it("returns focus to the opener when the drawer closes", async () => {
    mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    const opener = within(screen.getByText("Demo B").closest("article")).getByRole("button", { name: /Details/ });
    opener.focus();
    fireEvent.click(opener);
    const d = screen.getByRole("dialog", { name: "Demo B details" });
    await waitFor(() => expect(d.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(d).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it("opens a Help drawer that lists the ways to start, closes on Escape and returns focus to Help", async () => {
    mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    const helpBtn = screen.getByRole("button", { name: "Help" });
    fireEvent.click(helpBtn);
    const d = screen.getByRole("dialog", { name: "How to start a demo" });
    expect(within(d).getByText("Restore last set")).toBeInTheDocument();
    expect(within(d).getByText("scripts/setup.sh --start-top=10")).toBeInTheDocument();
    expect(within(d).getByText("npm run agent")).toBeInTheDocument();
    expect(within(d).getByRole("button", { name: "Close" })).toHaveFocus();
    fireEvent.keyDown(d, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(helpBtn).toHaveFocus();
  });
  it("shows one drawer at a time: opening a demo's details closes Help", async () => {
    mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    fireEvent.click(within(screen.getByText("Demo B").closest("article")).getByRole("button", { name: /Details/ }));
    expect(screen.queryByRole("dialog", { name: "How to start a demo" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Demo B details" })).toBeInTheDocument();
  });
  it("opens the details drawer for a planned card", async () => {
    mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.click(within(screen.getByText("Passwordless").closest("article")).getByRole("button", { name: /Details/ }));
    const d = screen.getByRole("dialog", { name: "Passwordless details" });
    expect(within(d).getByText(/built or proposed but not registered/)).toBeInTheDocument();
    expect(within(d).getByText(/A3, wave 3/)).toBeInTheDocument();
  });
  it("shows items with no kind alongside the rest", async () => {
    const body = shelf();
    body.planned.push({ id: "Z9", name: "Mystery", kind: null, group: "A", wave: 2, status: { state: "planned" } });
    mockFetch(body);
    render(<App />);
    await screen.findByText("Demo A");
    expect(screen.getByText("Mystery")).toBeInTheDocument();
  });
  it("auto-refreshes every 30 s and pauses while the tab is hidden", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    await act(async () => {}); // flush the one-shot mounts (/api/notice, shelf link)
    // Mount-time calls are: the shelf + whatever one-shot services fetch (notice,
    // shelf link). The refresh schedule is what this test proves: exactly ONE more
    // fetch per visible 30 s tick, none while hidden.
    const base = f.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(f.mock.calls.length).toBe(base + 1);
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    await act(async () => { vi.advanceTimersByTime(90000); });
    expect(f.mock.calls.length).toBe(base + 1);
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(f.mock.calls.length).toBe(base + 2);
  });
  it("manual Refresh posts to the refresh endpoint", async () => {
    const f = mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(f).toHaveBeenCalledWith("/api/shelf/refresh", { method: "POST" }));
  });
  it("announces status changes in a live region", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    const next = shelf();
    next.demos[0].status = st("broken");
    f.mockImplementation(async () => ({ ok: true, json: async () => next }));
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(screen.getByRole("status")).toHaveTextContent("Demo A is now Broken");
  });
  it("shows a banner, keeping the last state, when the server cannot be reached", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    f.mockImplementation(async () => { throw new Error("offline"); });
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot reach the shelf server");
    expect(screen.getByText("Demo A")).toBeInTheDocument();
  });
  describe("after Start returns, until the demo answers", () => {
    const downDemo = () => shelf({ startEnabled: true, demos: [{ ...shelf().demos[1], canStart: true, composeFile: "/x/c.yml" }] });
    // Start returns at once (compose only created the containers); the shelf's health check says down for `downPolls` refreshes, then ready.
    const startFetch = (downPolls) => {
      let polls = 0;
      const f = vi.fn(async (url, init = {}) => {
        const u = String(url);
        if (u === "/api/info") return { ok: true, json: async () => INFO };
        if (u === "/api/demos/b/start" && init.method === "POST") return { ok: true, json: async () => ({ ok: true }) };
        const body = downDemo();
        if (u === "/api/shelf/refresh") { polls += 1; if (polls > downPolls) body.demos[0].status = st("ready"); }
        return { ok: true, json: async () => body };
      });
      vi.stubGlobal("fetch", f);
      return f;
    };
    const press = async () => { fireEvent.click(within(screen.getByText("Demo B").closest("article")).getByRole("button", { name: /^Start/ })); await act(async () => {}); };

    it("shows Starting with a spinner, not Down, and flips to Ready when the health check answers", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      startFetch(2);
      render(<App />);
      await screen.findByText("Demo B");
      await press();
      const b = () => within(screen.getByText("Demo B").closest("article"));
      expect(b().getByText("Starting")).toBeInTheDocument();
      expect(b().queryByText("Down")).toBeNull();
      expect(b().getByRole("button", { name: /^Start/ })).toBeDisabled();
      expect(b().getByRole("button", { name: /^Start/ }).querySelector(".spin")).not.toBeNull();
      expect(b().getByText(/waiting for Demo B to answer/)).toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(2500); });
      expect(b().getByText("Starting")).toBeInTheDocument(); // still not answering after one look
      await act(async () => { vi.advanceTimersByTime(5000); });
      expect(b().getByText("Ready")).toBeInTheDocument();
      expect(b().queryByText(/waiting for Demo B/)).toBeNull();
      expect(b().getByRole("button", { name: /^Start/ }).querySelector(".spin")).toBeNull();
      expect(document.querySelector(".note").textContent).toMatch(/Demo B: ready/);
    });
    it("gives up after 2 minutes: the spinner stops and the card says it started but is not answering", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      startFetch(Infinity);
      render(<App />);
      await screen.findByText("Demo B");
      await press();
      await act(async () => { vi.advanceTimersByTime(119000); });
      expect(screen.getByText("Starting")).toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(5000); });
      const b = within(screen.getByText("Demo B").closest("article"));
      expect(b.queryByText("Starting")).toBeNull();
      expect(b.getByText("Down")).toBeInTheDocument();
      expect(b.getByText(/still not answering after 2 minutes/)).toBeInTheDocument();
      expect(b.getByRole("button", { name: /^Start/ }).querySelector(".spin")).toBeNull();
      expect(b.getByRole("button", { name: /^Start/ })).toBeEnabled(); // the user can try again
    });
  });
  describe("the running limit", () => {
    const downDemo = () => shelf({ startEnabled: true, demos: [{ ...shelf().demos[1], canStart: true, composeFile: "/x/c.yml", repo: "https://github.com/curtismu7/x-LAB" }] });
    const startReplies = (status, body) => {
      vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
        const u = String(url);
        if (u === "/api/info") return { ok: true, json: async () => INFO };
        if (u === "/api/demos/b/start" && init.method === "POST") return { ok: status === 200, json: async () => body };
        return { ok: true, json: async () => downDemo() };
      }));
    };
    const pressStart = async () => { await screen.findByText("Demo B"); fireEvent.click(within(screen.getByText("Demo B").closest("article")).getByRole("button", { name: /^Start/ })); };

    it("tells the user which demo was stopped to make room", async () => {
      startReplies(200, { ok: true, stopped: [{ id: "old", name: "Oldest Lab" }], limit: 10 });
      render(<App />);
      await pressStart();
      await waitFor(() => expect(document.querySelector(".note").textContent).toMatch(/Stopped Oldest Lab \(the oldest\) to stay within 10 running/));
      expect(screen.getAllByRole("status").map((e) => e.textContent).join(" ")).toContain("Stopped Oldest Lab");
    });
    it("says how many are running when Start is refused for being over the limit", async () => {
      startReplies(409, { ok: false, error: "too-many-running:24:10", output: "24 demos are running and the limit is 10. Stop some first (Stop all stops every one)." });
      render(<App />);
      await pressStart();
      await waitFor(() => expect(document.querySelector(".note").textContent).toMatch(/did not run: 24 demos are running and the limit is 10/));
    });
  });
  describe("a refused action shows on its card", () => {
    const MSG = "13 demos are running and the limit is 10. Stop some first (Stop all stops every one).";
    const shelfB = (over = {}) => shelf({ startEnabled: true, agent: "up", demos: [{ ...shelf().demos[1], canStart: true, composeFile: "/x/c.yml", repo: "https://github.com/curtismu7/x-LAB" }, shelf().demos[0]], ...over });
    const replies = (byPath, body = shelfB()) => {
      const f = vi.fn(async (url, init = {}) => {
        const u = String(url);
        if (u === "/api/info") return { ok: true, json: async () => INFO };
        if (init.method === "POST" && byPath[u]) { const [status, b] = byPath[u](); return { ok: status === 200, status, json: async () => b }; }
        return { ok: true, json: async () => body };
      });
      vi.stubGlobal("fetch", f);
      return f;
    };
    it.each(["start", "deploy"])("a 409 too-many-running from %s puts the agent's words on the card as an alert", async (action) => {
      replies({ [`/api/demos/b/${action}`]: () => [409, { ok: false, error: "too-many-running:13:10", output: MSG }] });
      render(<App />);
      await screen.findByText("Demo B");
      fireEvent.click(cardOf("Demo B").getByRole("button", { name: new RegExp(`^${action}`, "i") }));
      const alert = await cardOf("Demo B").findByRole("alert");
      expect(alert).toHaveTextContent(`${action[0].toUpperCase()}${action.slice(1)} did not run: ${MSG}`);
      expect(cardOf("Demo A").queryByRole("alert")).toBeNull(); // only on the card that was pressed
    });
    it.each([
      ["network-pool-nearly-full:29", "Docker has too many networks (29 >= limit 28). Fix: docker network prune -f", /Docker has too many networks \(29 >= limit 28\)/],
      ["compose-failed", "service x: port is already allocated", /docker compose failed\. Its output: service x: port is already allocated/],
      ["agent-token-rejected", undefined, /rejected the shelf's token/],
      ["docker-context-not-orbstack", undefined, /Docker's context is not OrbStack/],
      ["agent-not-running", undefined, /the start agent is not running/],
    ])("%s shows on the card", async (error, output, text) => {
      replies({ "/api/demos/b/start": () => [error === "agent-not-running" ? 503 : 409, { ok: false, error, ...(output ? { output } : {}) }] });
      render(<App />);
      await screen.findByText("Demo B");
      fireEvent.click(cardOf("Demo B").getByRole("button", { name: /^Start/ }));
      expect(await cardOf("Demo B").findByRole("alert")).toHaveTextContent(text);
    });
    it("a reply with no body still says what happened", async () => {
      vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => (init.method === "POST" && String(url) === "/api/demos/b/start" ? { ok: false, status: 502, json: async () => { throw new Error("not json"); } } : { ok: true, json: async () => (String(url) === "/api/info" ? INFO : shelfB()) })));
      render(<App />);
      await screen.findByText("Demo B");
      fireEvent.click(cardOf("Demo B").getByRole("button", { name: /^Start/ }));
      expect(await cardOf("Demo B").findByRole("alert")).toHaveTextContent("Start did not run: HTTP 502");
    });
    it("the message stays until that card's next action, which clears it", async () => {
      let n = 0;
      replies({ "/api/demos/b/start": () => (++n === 1 ? [409, { ok: false, error: "too-many-running:13:10", output: MSG }] : [200, { ok: true, id: "b", action: "start", output: "" }]) });
      render(<App />);
      await screen.findByText("Demo B");
      fireEvent.click(cardOf("Demo B").getByRole("button", { name: /^Start/ }));
      await cardOf("Demo B").findByRole("alert");
      await waitFor(() => expect(cardOf("Demo B").getByRole("button", { name: /^Start/ })).toBeEnabled());
      fireEvent.click(cardOf("Demo B").getByRole("button", { name: /^Start/ }));
      await waitFor(() => expect(cardOf("Demo B").queryByRole("alert")).toBeNull());
    });
    it("shows the running count against the limit, and only the limit when the count is unknown", async () => {
      mockFetch(shelfB({ runningLimit: { running: 13, max: 10 } }));
      const { unmount } = render(<App />);
      await screen.findByText("Demo B");
      expect(screen.getByTestId("running-limit")).toHaveTextContent("13 running · limit 10");
      expect(screen.getByTestId("running-limit")).toHaveAttribute("data-state", "full");
      unmount();
      mockFetch(shelfB({ runningLimit: { running: null, max: 7 } }));
      render(<App />);
      await screen.findByText("Demo B");
      expect(screen.getByTestId("running-limit")).toHaveTextContent("Limit 7 running");
    });
    it("no limit line when the server sends none", async () => {
      mockFetch(shelfB());
      render(<App />);
      await screen.findByText("Demo B");
      expect(screen.queryByTestId("running-limit")).toBeNull();
    });
  });
  describe("running demos come first", () => {
    const order = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    const mixed = () => shelf({ demos: [
      { id: "d1", name: "Down One", catalogId: "A1", wave: 0, url: "http://localhost:4601", status: st("down") },
      { id: "r1", name: "Run One", catalogId: "A5", wave: 2, url: "http://localhost:4602", status: st("ready"), isNew: true, addedAt: "2026-11-09" },
      { id: "d2", name: "Down Two", catalogId: "A2", wave: 1, url: "http://localhost:4603", status: st("down"), isNew: true, addedAt: "2026-11-09" },
      { id: "r2", name: "Run Two", catalogId: "A3", wave: 1, url: "http://localhost:4604", status: st("needs-setup") },
      { id: "r3", name: "Run Three", catalogId: "A4", wave: 1, url: "http://localhost:4605", status: st("up-no-contract") },
    ] });
    it("lists every running card first, keeping the plan order inside each group; planned ideas stay after", async () => {
      mockFetch(mixed());
      render(<App />);
      await screen.findByText("Run One");
      expect(order()).toEqual(["Run Two", "Run Three", "Run One", "Down One", "Down Two", "Passwordless"]);
    });
    it("keeps running first under a filter and under What's new, with the New badges", async () => {
      mockFetch(mixed());
      render(<App />);
      await screen.findByText("Run One");
      fireEvent.click(screen.getByTestId("whats-new"));
      await waitFor(() => expect(order()).toEqual(["Run One", "Down Two"]));
      expect(cardOf("Run One").getByText("New")).toBeInTheDocument();
      expect(cardOf("Down Two").getByText("New")).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("whats-new"));
      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "One" } });
      await waitFor(() => expect(order()).toEqual(["Run One", "Down One"]));
    });
  });
  it("banner on first load failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    render(<App />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Is it running?"));
  });
});

// ---- tags -----------------------------------------------------------------------------------------------------------------
const tagShelf = () => shelf({
  tagGroups: [
    { id: "product", label: "Ping products", tags: [{ id: "pf", label: "PingFederate" }, { id: "p1", label: "PingOne" }] },
    { id: "mode", label: "Simulated or real", tags: [{ id: "simulated", label: "Simulated", hint: "offline, fake data" }, { id: "real", label: "Real" }] },
    { id: "standard", label: "Standards and protocols", tags: [{ id: "oidc", label: "OpenID Connect" }, { id: "mcp", label: "MCP" }, { id: "unused", label: "Unused tag" }] },
  ],
  demos: [
    { id: "a", name: "Demo A", catalogId: "C1", kind: "Demo", group: "C", description: "token playground", url: "http://localhost:4500", tags: ["pf", "simulated", "real", "oidc"], status: st("ready") },
    { id: "b", name: "Demo B", catalogId: "A1", kind: "Tester", group: "A", description: "mfa checks", url: "http://localhost:4501", tags: ["p1", "simulated", "oidc"], status: st("ready") },
    { id: "c", name: "Demo C", catalogId: "A2", kind: "Tool", group: "A", description: "plain page", url: "http://localhost:4502", tags: ["pf", "simulated", "mcp"], status: st("ready") },
    { id: "d", name: "Demo D", catalogId: "A4", kind: "Demo", group: "A", description: "real only", url: "http://localhost:4503", tags: ["p1", "real", "mcp"], status: st("ready") },
  ],
});
const names = () => screen.queryAllByRole("heading", { level: 3 }).map((h) => h.textContent).sort();
const openTags = () => { if (!screen.queryByRole("region", { name: "Filter by tag" })) fireEvent.click(screen.getByRole("button", { name: "Filter by tag" })); };
const chip = (label) => { openTags(); return within(screen.getByRole("region", { name: "Filter by tag" })).getByRole("button", { name: new RegExp(`^${label}`) }); }; // the card pills have the same names

describe("tags", () => {

  it("shows each tag group with a count on every chip", async () => {
    mockFetch(tagShelf());
    render(<App />);
    await screen.findByText("Demo A");
    openTags();
    for (const g of ["Ping products", "Simulated or real", "Standards and protocols"]) expect(screen.getByRole("group", { name: g })).toBeInTheDocument();
    expect(chip("PingFederate")).toHaveTextContent("2");
    expect(chip("Simulated")).toHaveTextContent("3");
    expect(chip("Real")).toHaveTextContent("2");
    expect(screen.getByText("5 of 5 shown")).toBeInTheDocument(); // 4 registered + 1 planned
  });

  it("one tag filters the cards, and an untagged planned idea drops out", async () => {
    mockFetch(tagShelf());
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.click(chip("PingFederate"));
    expect(names()).toEqual(["Demo A", "Demo C"]);
    expect(chip("PingFederate")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("2 of 5 shown")).toBeInTheDocument();
  });

  it("a tagged planned idea shows pills, is filtered by them, and drops out when a mode tag is picked", async () => {
    const body = tagShelf();
    body.planned = [{ id: "A3", name: "Passwordless", kind: "Demo", group: "A", wave: 3, tags: ["p1", "mcp"], status: { state: "planned" } }];
    mockFetch(body);
    render(<App />);
    await screen.findByText("Demo A");
    const card = screen.getByRole("article", { name: "Passwordless (planned)" });
    expect(within(card).getByRole("button", { name: "PingOne" })).toBeInTheDocument();
    fireEvent.click(chip("MCP"));
    expect(names()).toEqual(["Demo C", "Demo D", "Passwordless"]);
    fireEvent.click(chip("Real"));
    expect(names()).toEqual(["Demo D"]);
  });

  it("OR inside a group: two products show the union", async () => {
    mockFetch(tagShelf());
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.click(chip("PingFederate")); fireEvent.click(chip("PingOne"));
    expect(names()).toEqual(["Demo A", "Demo B", "Demo C", "Demo D"]);
  });

  it("AND across groups: PingFederate and Real narrows to the demos that have both", async () => {
    mockFetch(tagShelf());
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.click(chip("PingFederate")); fireEvent.click(chip("Real"));
    expect(names()).toEqual(["Demo A"]);
  });

  it("counts follow the other filters: after picking MCP, Simulated counts only the MCP demos that are simulated", async () => {
    mockFetch(tagShelf());
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.click(chip("MCP"));
    expect(chip("Simulated")).toHaveTextContent("1"); // Demo C
    expect(chip("Real")).toHaveTextContent("1"); // Demo D
    expect(chip("OpenID Connect")).not.toBeDisabled(); // same group as MCP: the chips in one group are alternatives, so it still counts all OIDC demos
    expect(chip("OpenID Connect")).toHaveTextContent("2");
  });

  it("a chip that would lead nowhere is disabled: PingOne and Real leave only Demo D, which is not OIDC", async () => {
    mockFetch(tagShelf());
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.click(chip("PingOne")); fireEvent.click(chip("Real"));
    expect(names()).toEqual(["Demo D"]);
    expect(chip("OpenID Connect")).toBeDisabled();
    expect(chip("MCP")).not.toBeDisabled();
  });

  it("a tag nothing carries is disabled; a picked tag can always be unpicked", async () => {
    mockFetch(tagShelf());
    render(<App />);
    await screen.findByText("Demo A");
    expect(chip("Unused tag")).toBeDisabled();
    fireEvent.click(chip("PingFederate")); fireEvent.click(chip("OpenID Connect")); fireEvent.click(chip("Real"));
    expect(names()).toEqual(["Demo A"]);
    fireEvent.click(chip("PingOne")); // would give nothing with the rest
    expect(chip("Real")).not.toBeDisabled();
  });

  it("search also matches tag names and ids", async () => {
    mockFetch(tagShelf());
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "openid" } });
    expect(names()).toEqual(["Demo A", "Demo B"]);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "mcp" } });
    expect(names()).toEqual(["Demo C", "Demo D"]);
  });

  it("search finds a card by an extra catalog id it covers", async () => {
    const body = tagShelf();
    body.demos[0] = { ...body.demos[0], alsoCatalogIds: ["A44"] };
    mockFetch(body);
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "a44" } });
    expect(names()).toEqual(["Demo A"]);
  });

  it("Clear tags resets the chips and is only offered when something is picked", async () => {
    mockFetch(tagShelf());
    render(<App />);
    await screen.findByText("Demo A");
    expect(screen.queryByRole("button", { name: "Clear tags" })).toBeNull();
    fireEvent.click(chip("Real"));
    fireEvent.click(screen.getByRole("button", { name: "Clear tags" }));
    expect(names()).toEqual(["Demo A", "Demo B", "Demo C", "Demo D", "Passwordless"]);
    expect(screen.queryByRole("button", { name: "Clear tags" })).toBeNull();
  });

  it("keeps the filter in the address so a filtered view can be shared", async () => {
    mockFetch(tagShelf());
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.click(chip("PingFederate")); fireEvent.click(chip("Real"));
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "token" } });
    const p = new URLSearchParams(window.location.search);
    expect(p.get("tags")).toBe("pf,real");
    expect(p.get("q")).toBe("token");
    fireEvent.click(screen.getByRole("button", { name: "Clear tags" }));
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "" } });
    expect(window.location.search).toBe(""); // the defaults need no param
  });

  it("the status row is a summary, not a filter: every card shows and the address stays clean", async () => {
    window.history.replaceState(null, "", "/");
    mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    expect(screen.getByText("Demo A")).toBeInTheDocument();
    expect(screen.getByText("Demo B")).toBeInTheDocument();
    const summary = screen.getByRole("region", { name: "Summary by status" });
    expect(within(summary).getByText("All").closest("span")).not.toBeNull();
    expect(screen.queryByLabelText("Status")).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("an old ?status= link still loads with every card shown (the param is ignored)", async () => {
    window.history.replaceState(null, "", "/?status=new");
    mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    expect(screen.getByText("Passwordless")).toBeInTheDocument();
    expect(screen.queryByLabelText("Status")).toBeNull();
  });

  it("starts from the address: ?tags=real&q=real picks the chip and the search, and unknown tags are ignored", async () => {
    window.history.replaceState(null, "", "/?tags=real,bogus&q=only");
    mockFetch(tagShelf());
    render(<App />);
    await screen.findByText("Demo D");
    expect(names()).toEqual(["Demo D"]);
    expect(chip("Real")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Search")).toHaveValue("only");
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("tags")).toBe("real")); // bogus dropped
  });

  it("card pills toggle the same filter, and Details lists every tag under its group", async () => {
    mockFetch(tagShelf());
    render(<App />);
    await screen.findByText("Demo A");
    const card = screen.getByText("Demo B").closest("article");
    fireEvent.click(within(card).getByRole("button", { name: "OpenID Connect" }));
    expect(names()).toEqual(["Demo A", "Demo B"]);
    expect(chip("OpenID Connect")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(screen.getByText("Demo B").closest("article")).getByRole("button", { name: /^Details/ }));
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByText("Ping products").nextSibling).toHaveTextContent("PingOne");
    expect(within(dlg).getByText("Standards and protocols").nextSibling).toHaveTextContent("OpenID Connect");
  });

  it("a server with no tag groups (older server) shows no tag panel and still works", async () => {
    mockFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    expect(screen.queryByRole("region", { name: "Filter by tag" })).toBeNull();
    expect(screen.getByText("Demo B")).toBeInTheDocument();
  });
});

describe("What's new", () => {
  const withNew = () => shelf({ newWindowHours: 48, demos: shelf().demos.map((d) => ({ ...d, addedAt: d.id === "c" ? "2026-10-01" : "2026-11-09T07:06:25-06:00", isNew: d.id !== "c" })) });
  it("shows a chip with the count of new demos; pressing it filters to them and pressing again shows all", async () => {
    mockFetch(withNew());
    render(<App />);
    await screen.findByText("Demo A");
    const chip = screen.getByRole("button", { name: /What's new/ });
    expect(chip).toHaveTextContent("What's new · 2");
    expect(chip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Demo A")).toBeInTheDocument();
    expect(screen.getByText("Demo B")).toBeInTheDocument();
    expect(screen.queryByText("Demo C")).toBeNull();
    expect(screen.queryByText("Passwordless")).toBeNull();
    fireEvent.click(chip);
    expect(screen.getByText("Demo C")).toBeInTheDocument();
    expect(screen.getByText("Passwordless")).toBeInTheDocument();
  });
  it("puts a New badge on the new cards only, and in their Details", async () => {
    mockFetch(withNew());
    render(<App />);
    await screen.findByText("Demo A");
    expect(cardOf("Demo A").getByText("New")).toBeInTheDocument();
    expect(cardOf("Demo B").getByText("New")).toBeInTheDocument();
    expect(cardOf("Demo C").queryByText("New")).toBeNull();
    fireEvent.click(cardOf("Demo A").getByRole("button", { name: /Details/ }));
    const drawer = within(screen.getByRole("dialog", { name: "Demo A details" }));
    expect(drawer.getByText("New")).toBeInTheDocument();
    expect(drawer.getByText("2026-11-09T07:06:25-06:00")).toBeInTheDocument();
  });
  it("the count follows the other filters, like a tag chip", async () => {
    mockFetch(withNew());
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "mfa" } });
    expect(screen.getByRole("button", { name: /What's new/ })).toHaveTextContent("What's new · 1");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "plain" } });
    expect(screen.getByRole("button", { name: /What's new/ })).toBeDisabled();
  });
  it("is hidden when nothing is new", async () => {
    mockFetch(shelf({ newWindowHours: 48 }));
    render(<App />);
    await screen.findByText("Demo A");
    expect(screen.queryByRole("button", { name: /What's new/ })).toBeNull();
    expect(screen.queryByText("New", { selector: ".box__new" })).toBeNull();
  });
  it("stays pressable with an empty-state line when the new demos roll out of the window while it is on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = mockFetch(withNew());
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.click(screen.getByRole("button", { name: /What's new/ }));
    f.mockImplementation(async (url) => (String(url) === "/api/info" ? { ok: true, json: async () => INFO } : { ok: true, json: async () => shelf({ newWindowHours: 48 }) }));
    await act(async () => { vi.advanceTimersByTime(30000); });
    await screen.findByText(/Nothing was added in the last 48 hours/);
    const chip = screen.getByRole("button", { name: /What's new/ });
    expect(chip).toHaveTextContent("What's new · 0");
    expect(chip).not.toBeDisabled();
    fireEvent.click(chip);
    expect(screen.getByText("Demo C")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /What's new/ })).toBeNull();
  });
});

describe("Updates available banner", () => {
  const hrs = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const withUpdates = ({ apps = [], notice = null } = {}) => {
    const base = mockFetch(shelf());
    const f = vi.fn(async (url, init) => {
      if (String(url) === "/api/new-apps") return { ok: true, json: async () => ({ windowHours: 48, since: hrs(48), apps }) };
      if (String(url) === "/api/notice") return { ok: true, json: async () => ({ notice, updateCommand: "curl -fsSL https://example.invalid/install.sh | bash" }) };
      if (String(url) === "/api/releases") return { ok: true, json: async () => null };
      return base(url, init);
    });
    vi.stubGlobal("fetch", f);
    return f;
  };
  const A = { id: "a-lab", dir: "a-LAB", name: "Alpha Lab", description: "", addedAt: hrs(5.5), onThisMachine: true };
  const B = { id: "b-lab", dir: "b-LAB", name: "Beta Lab", description: "", addedAt: hrs(30), onThisMachine: false };
  // jsdom under Node 26 here has no window.localStorage; give the page a fresh in-memory one per test.
  beforeEach(() => {
    const m = new Map();
    vi.stubGlobal("localStorage", { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() });
  });

  it("lists the new labs with their age and whether they are on this shelf, and keeps the UPDATES.md notice under them", async () => {
    withUpdates({ apps: [A, B], notice: "Re-run the installer for **new labs**." });
    render(<App />);
    const list = await screen.findByRole("list", { name: "New labs in the last 48 hours" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Alpha Lab added 5 hours ago · on your shelf");
    expect(items[1]).toHaveTextContent("Beta Lab added 30 hours ago · run the update command to get it");
    expect(screen.getByText("new labs").tagName).toBe("STRONG");
    expect(screen.getByText("curl -fsSL https://example.invalid/install.sh | bash")).toBeInTheDocument();
  });

  it("shows the notice alone when no lab is new, and no banner when neither part has content", async () => {
    withUpdates({ notice: "Just a notice." });
    const { unmount } = render(<App />);
    expect(await screen.findByText("Just a notice.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "New labs in the last 48 hours" })).toBeNull();
    unmount();
    withUpdates();
    render(<App />);
    await screen.findByText("Demo A");
    await act(async () => {});
    expect(screen.queryByText("Updates available.")).toBeNull();
  });

  it("folds to a one-line strip when closed, stays folded for the same set, and opens again when a new lab is added", async () => {
    withUpdates({ apps: [A] });
    const first = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss update banner" }));
    expect(screen.queryByRole("list", { name: "New labs in the last 48 hours" })).toBeNull();
    expect(screen.getByText("Updates available.")).toBeInTheDocument();
    first.unmount();

    withUpdates({ apps: [A] });
    const second = render(<App />);
    await screen.findByText("Demo A");
    await act(async () => {});
    expect(screen.queryByRole("list", { name: "New labs in the last 48 hours" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show update banner" }));
    expect(screen.getByRole("list", { name: "New labs in the last 48 hours" })).toBeInTheDocument();
    second.unmount();

    withUpdates({ apps: [B, A] });
    render(<App />);
    expect(await screen.findByText("Beta Lab")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "New labs in the last 48 hours" })).toBeInTheDocument();
  });
});
