import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.jsx";
import { cloneCommand } from "../install.js";

const st = (state) => ({ state, lastChecked: "2026-10-21T10:00:00Z", latencyMs: 12 });
const REPO = "https://github.com/curtismu7/x-LAB";
const card = (id, name, over = {}) => ({ id, name, catalogId: id.toUpperCase(), kind: "Demo", group: "C", wave: 0, description: `${name} text`, url: "http://localhost:4500", where: "installed", composeFile: "/x/c.yml", startCommand: "docker compose -f /x/c.yml up -d", canStart: true, install: "unknown", imagesBuilt: null, repo: null, status: st("down"), ...over });
const body = (demos, over = {}) => ({ startEnabled: true, agent: "up", installPending: false, groups: { C: "Tokens" }, demos, planned: [], ...over });
const cardOf = (name) => within(screen.getByRole("heading", { name }).closest("article"));
const mockFetch = (b) => { const f = vi.fn(async () => ({ ok: true, json: async () => b })); vi.stubGlobal("fetch", f); return f; };
const clipboard = (writeText) => Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
const start = (name) => cardOf(name).getByRole("button", { name: /^Start/ });
const stop = (name) => cardOf(name).getByRole("button", { name: /^Stop/ });
const NOT_BUILT = "Installed, not built yet: Start builds it (can take a few minutes)";
beforeEach(() => { window.history.replaceState(null, "", "/?status=all"); }); // tests look at every card; the page itself opens on Ready
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); window.history.replaceState(null, "", "/"); });

const render1 = async (demos, name, over) => { mockFetch(body(demos, over)); render(<App />); await screen.findByRole("heading", { name }); };

describe("install states on a card", () => {
  it("running: unchanged (Stop on, Start off, no install text)", async () => {
    await render1([card("r", "Run R", { install: "installed", imagesBuilt: true, status: st("ready") })], "Run R");
    expect(stop("Run R")).toBeEnabled();
    expect(start("Run R")).toBeDisabled();
    expect(start("Run R")).toHaveAttribute("title", "Already running");
    expect(cardOf("Run R").queryByText(/Installed, |Not installed/)).toBeNull();
  });
  it("running wins even if the server said not installed", async () => {
    await render1([card("r", "Run R", { install: "not-installed", status: st("ready"), repo: REPO })], "Run R");
    expect(cardOf("Run R").queryByText("Not installed")).toBeNull();
    expect(cardOf("Run R").queryByRole("button", { name: /Copy clone/ })).toBeNull();
    expect(stop("Run R")).toBeEnabled();
  });
  it("installed and stopped: says so in text, Start enabled with no warning", async () => {
    await render1([card("s", "Stopped S", { install: "installed", imagesBuilt: true })], "Stopped S");
    expect(cardOf("Stopped S").getByText("Installed, not answering.")).toBeInTheDocument();
    expect(start("Stopped S")).toBeEnabled();
    expect(start("Stopped S")).not.toHaveAttribute("title");
    expect(stop("Stopped S")).toBeDisabled();
  });
  it("installed but images not built: says so in text and in the tooltip, Start stays enabled", async () => {
    await render1([card("n", "Unbuilt N", { install: "installed", imagesBuilt: false })], "Unbuilt N");
    expect(cardOf("Unbuilt N").getByText(`${NOT_BUILT}.`)).toBeInTheDocument();
    expect(start("Unbuilt N")).toBeEnabled();
    expect(start("Unbuilt N")).toHaveAttribute("title", NOT_BUILT);
  });
  it("installed with images unknown: plain stopped, no not-built claim", async () => {
    await render1([card("u", "Maybe U", { install: "installed", imagesBuilt: null })], "Maybe U");
    expect(cardOf("Maybe U").queryByText(/not built/)).toBeNull();
    expect(start("Maybe U")).toBeEnabled();
  });
  it("not installed: a visible tag, Start disabled with a reason, Stop disabled, Copy clone command", async () => {
    await render1([card("i", "Absent I", { install: "not-installed", repo: REPO })], "Absent I");
    const c = cardOf("Absent I");
    expect(c.getByText("Not installed")).toBeInTheDocument();
    expect(c.getByText(/Get the repo next to the shelf/)).toBeInTheDocument();
    expect(start("Absent I")).toBeDisabled();
    expect(start("Absent I")).toHaveAttribute("title", expect.stringMatching(/^Not installed on this machine/));
    expect(stop("Absent I")).toBeDisabled();
    expect(c.getByRole("button", { name: /Copy clone command/ })).toBeEnabled();
    expect(c.getByRole("heading", { name: "Absent I" }).closest("article")).toHaveAttribute("data-install", "not-installed");
  });
  it("not installed without a repo (or with an unusable one): tag and reason, but no Copy button", async () => {
    const bad = ["javascript:alert(1)", "http://github.com/o/n", "https://github.com/o/n?x=1", "https://evil.example/o/n", "https://github.com/o/n x", "https://github.com/../n", null];
    for (const [i, repo] of bad.entries()) {
      const { unmount } = (mockFetch(body([card("i", `Absent ${i}`, { install: "not-installed", repo })])), render(<App />));
      await screen.findByRole("heading", { name: `Absent ${i}` });
      expect(cardOf(`Absent ${i}`).getByText("Not installed")).toBeInTheDocument();
      expect(cardOf(`Absent ${i}`).queryByRole("button", { name: /Copy clone/ })).toBeNull();
      unmount();
    }
  });
  it("unknown: exactly as before (Start enabled, no install text, no Copy clone)", async () => {
    await render1([card("k", "Unsure K", { install: "unknown", repo: REPO })], "Unsure K");
    const c = cardOf("Unsure K");
    expect(start("Unsure K")).toBeEnabled();
    expect(start("Unsure K")).not.toHaveAttribute("title");
    expect(c.queryByText(/Not installed|Installed, /)).toBeNull();
    expect(c.queryByRole("button", { name: /Copy clone/ })).toBeNull();
  });
  it("an older server that sends no install field behaves as unknown", async () => {
    const { install, imagesBuilt, repo, ...old } = card("o", "Old O"); // eslint-disable-line no-unused-vars
    await render1([old], "Old O");
    expect(start("Old O")).toBeEnabled();
    expect(cardOf("Old O").queryByText(/Not installed|Installed, /)).toBeNull();
  });
  it("no compose file: the existing reason, not an install claim", async () => {
    await render1([card("c", "Plain C", { composeFile: null, startCommand: null, canStart: false, install: "unknown" })], "Plain C");
    expect(start("Plain C")).toBeDisabled();
    expect(start("Plain C")).toHaveAttribute("title", "No compose file is registered for this demo");
    expect(cardOf("Plain C").queryByText(/Not installed/)).toBeNull();
  });
  it("mock and planned cards have no install state, even if the data says so", async () => {
    await render1([card("m", "Mock M", { where: "mock", composeFile: null, startCommand: null, canStart: false, install: "not-installed", repo: REPO, status: st("ready") })], "Mock M", { planned: [{ id: "A3", name: "Planned P", kind: "Demo", group: "C", wave: 1, install: "not-installed", status: { state: "planned" } }] });
    expect(screen.queryByText("Not installed")).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy clone/ })).toBeNull();
  });
  it("Present mode hides the install text and the Copy button", async () => {
    await render1([card("i", "Absent I", { install: "not-installed", repo: REPO })], "Absent I");
    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    expect(screen.queryByText("Not installed")).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy clone/ })).toBeNull();
  });
  it("the Details drawer says it in words and shows the command as text", async () => {
    await render1([card("i", "Absent I", { install: "not-installed", repo: REPO })], "Absent I");
    fireEvent.click(cardOf("Absent I").getByRole("button", { name: /Details/ }));
    const d = screen.getByRole("dialog", { name: "Absent I details" });
    expect(within(d).getByText("On this machine").nextSibling).toHaveTextContent("Not installed");
    expect(within(d).getByText(`git clone ${REPO}.git`)).toBeInTheDocument();
  });
});

describe("Copy clone command", () => {
  it("copies exactly git clone <repo>.git inside the click and says Copied", async () => {
    const writeText = vi.fn(async () => {});
    clipboard(writeText);
    await render1([card("i", "Absent I", { install: "not-installed", repo: REPO })], "Absent I");
    fireEvent.click(cardOf("Absent I").getByRole("button", { name: /Copy clone command/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`git clone ${REPO}.git`));
    expect(writeText).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(cardOf("Absent I").getByText("Copied")).toBeInTheDocument());
  });
  it("a repo address that already ends in .git gives the same command", () => {
    expect(cloneCommand(`${REPO}.git`)).toBe(`git clone ${REPO}.git`);
    expect(cloneCommand(REPO)).toBe(`git clone ${REPO}.git`);
  });
  it("if the browser refuses, the command is shown as text and selected, and nothing says Copied", async () => {
    clipboard(vi.fn(async () => { throw new Error("denied"); }));
    await render1([card("i", "Absent I", { install: "not-installed", repo: REPO })], "Absent I");
    fireEvent.click(cardOf("Absent I").getByRole("button", { name: /Copy clone command/ }));
    const code = await within(screen.getByRole("heading", { name: "Absent I" }).closest("article")).findByText(`git clone ${REPO}.git`);
    expect(code.tagName).toBe("CODE");
    expect(cardOf("Absent I").queryByText("Copied")).toBeNull();
    await waitFor(() => expect(window.getSelection().toString()).toBe(`git clone ${REPO}.git`));
  });
  it("if there is no clipboard at all it falls back the same way", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await render1([card("i", "Absent I", { install: "not-installed", repo: REPO })], "Absent I");
    fireEvent.click(cardOf("Absent I").getByRole("button", { name: /Copy clone command/ }));
    expect(await cardOf("Absent I").findByText(`git clone ${REPO}.git`)).toBeInTheDocument();
  });
});

describe("cloneCommand rejects anything that is not a plain github.com repo address", () => {
  it.each(["javascript:alert(1)", "http://github.com/o/n", "https://github.com/o/n?x", "https://github.com/o/n#x", "https://u@github.com/o/n", "https://github.com:443/o/n", "https://github.com/o/n;id", "https://github.com/o/n\nid", "https://github.com/o/n x", "https://github.com/o", "https://github.com/o/n/", "https://github.com/o/n.git.git", `https://github.com/o/${"n".repeat(101)}`, "", null, undefined, 5])("%j", (v) => expect(cloneCommand(v)).toBeNull());
});

describe("first load while the install check is pending", () => {
  it("looks again after a short wait, not after 30 s, then settles", async () => {
    const first = body([card("i", "Absent I", { install: "unknown" })], { installPending: true });
    const second = body([card("i", "Absent I", { install: "not-installed" })], { installPending: false });
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ notice: null }) }) // /api/notice on mount
      .mockResolvedValueOnce({ ok: true, json: async () => first })
      .mockResolvedValue({ ok: true, json: async () => second });
    vi.stubGlobal("fetch", f);
    render(<App />);
    await screen.findByRole("heading", { name: "Absent I" });
    expect(screen.queryByText("Not installed")).toBeNull();
    expect(await screen.findByText("Not installed", {}, { timeout: 8000 })).toBeInTheDocument(); // the 30 s timer has not fired: this is the quick look
    await new Promise((r) => setTimeout(r, 100)); // let mount-time one-shots (notice/shelf-link) settle
    const base = f.mock.calls.length;
    await new Promise((r) => setTimeout(r, 1500));
    expect(f.mock.calls.length).toBe(base); // no more quick looks once nothing is pending
  }, 20000);
});

describe("shared Ping products warning (rule 20)", () => {
  it("no pingProducts: no warning row", async () => {
    await render1([card("p0", "Plain P")], "Plain P");
    expect(cardOf("Plain P").queryByText(/Needs shared Ping/)).toBeNull();
  });
  it("all products ready: no warning row", async () => {
    await render1([card("p1", "Green P", { pingProducts: [{ product: "pingfederate", state: "ready", url: "x" }] })], "Green P");
    expect(cardOf("Green P").queryByText(/Needs shared Ping/)).toBeNull();
  });
  it("a down product warns with a human name", async () => {
    await render1([card("p2", "Warn P", { pingProducts: [{ product: "pingfederate", state: "down" }, { product: "pingone", state: "ready" }] })], "Warn P");
    const w = cardOf("Warn P").getByText(/Needs shared Ping/).closest("p");
    expect(w.textContent).toMatch(/PingFederate: no shared instance running/);
    expect(w.textContent).not.toMatch(/PingOne/); // ready products are not listed
  });
  it("not-configured says where to fix it", async () => {
    await render1([card("p3", "Cfg P", { pingProducts: [{ product: "pingone", state: "not-configured" }] })], "Cfg P");
    expect(cardOf("Cfg P").getByText(/not configured in the shared env file/)).toBeInTheDocument();
  });
});
