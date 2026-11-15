import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.jsx";
import Root from "../Root.jsx";
import VerifyPage from "../VerifyPage.jsx";
import { VerifyBadge } from "../components/VerifyMark.jsx";

const INFO = {
  statuses: [
    { id: "verified", label: "Verified", meaning: "Checked and working as described." },
    { id: "in-progress", label: "In progress", meaning: "Being checked now. It may not work yet." },
    { id: "none", label: "Not checked", meaning: "Nobody has checked this one yet." },
  ],
  noteMax: 140,
};
const st = (state) => ({ state, lastChecked: "2026-11-15T10:00:00Z", latencyMs: 12 });
const mark = (status, extra = {}) => ({ status, label: INFO.statuses.find((s) => s.id === status).label, note: "", updatedAt: "2026-11-14", source: "shipped", ...extra });
const shelf = (over = {}) => ({
  startEnabled: true,
  verificationEditable: true,
  verificationInfo: INFO,
  groups: {},
  demos: [
    { id: "a", name: "Demo A", catalogId: "C1", kind: "Demo", wave: 0, description: "alpha", url: "http://localhost:4500", canStart: true, status: st("ready"), verification: mark("verified", { note: "Ran end to end on the mock." }) },
    { id: "b", name: "Demo B", catalogId: "A1", kind: "Tester", wave: 1, description: "beta", url: "http://localhost:4501", canStart: true, status: st("down"), verification: mark("in-progress", { note: "Rechecking after the rename.", source: "local" }) },
    { id: "c", name: "Demo C", catalogId: "A2", kind: "Tool", wave: 1, description: "gamma", url: "http://localhost:4502", canStart: true, status: st("down"), verification: null },
  ],
  planned: [],
  ...over,
});
const stubFetch = (body, put) => {
  const f = vi.fn(async (url, init = {}) => {
    if (String(url) === "/api/info") return { ok: true, json: async () => ({ source: "mock", realAvailable: false }) };
    if (String(url).startsWith("/api/verification/") && init.method === "PUT") return put(url, init);
    return { ok: true, json: async () => body };
  });
  vi.stubGlobal("fetch", f);
  return f;
};
beforeEach(() => { window.history.replaceState(null, "", "/"); });
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

const cardOf = (name) => within(screen.getByRole("heading", { name }).closest("article"));

describe("VerifyBadge", () => {
  it("renders nothing for no mark and for none", () => {
    const { container, rerender } = render(<VerifyBadge mark={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<VerifyBadge mark={mark("none")} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the server's label and the note, and says when the mark is only on this machine", () => {
    render(<VerifyBadge mark={mark("verified", { note: "Works", source: "local" })} />);
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.getByText("Works")).toBeInTheDocument();
    expect(screen.getByText("Set on this machine")).toBeInTheDocument();
  });

  it("can leave the note out", () => {
    render(<VerifyBadge mark={mark("verified", { note: "Works" })} note={false} />);
    expect(screen.queryByText("Works")).toBeNull();
  });
});

describe("marks on the shelf", () => {
  it("each tile shows its own mark and note; a tile with no mark shows none", async () => {
    stubFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    expect(cardOf("Demo A").getByText("Verified")).toBeInTheDocument();
    expect(cardOf("Demo A").getByText("Ran end to end on the mock.")).toBeInTheDocument();
    expect(cardOf("Demo B").getByText("In progress")).toBeInTheDocument();
    expect(cardOf("Demo B").getByText("Set on this machine")).toBeInTheDocument();
    expect(cardOf("Demo C").queryByText("Verified")).toBeNull();
    expect(cardOf("Demo C").queryByText("In progress")).toBeNull();
  });

  it("Details repeats the mark with its full note", async () => {
    stubFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    fireEvent.click(cardOf("Demo A").getByRole("button", { name: /Details/ }));
    const drawer = within(await screen.findByRole("dialog"));
    expect(drawer.getByText("Verification")).toBeInTheDocument();
    expect(drawer.getByText("Ran end to end on the mock.")).toBeInTheDocument();
  });

  it("the header links to the Verification page", async () => {
    stubFetch(shelf());
    render(<App />);
    await screen.findByText("Demo A");
    expect(screen.getByRole("link", { name: "Verification" })).toHaveAttribute("href", "#/verify");
  });
});

describe("Root", () => {
  it("shows the Verification page on #/verify and the shelf otherwise, following the address", async () => {
    stubFetch(shelf());
    render(<Root />);
    await screen.findByText("Demo A");
    expect(screen.queryByRole("heading", { name: /Verification/ })).toBeNull();
    act(() => { window.location.hash = "#/verify"; });
    expect(await screen.findByRole("heading", { name: /Verification/ })).toBeInTheDocument();
    act(() => { window.location.hash = ""; });
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Verification/ })).toBeNull());
  });
});

describe("Verification page", () => {
  const rowOf = (name) => within(screen.getByText(name, { selector: "b" }).closest("li"));

  it("lists every demo with its current mark, counts them, and explains the marks from the server's words", async () => {
    stubFetch(shelf());
    render(<VerifyPage />);
    await screen.findByText("Demo A", { selector: "b" });
    expect(screen.getAllByRole("listitem").filter((li) => li.classList.contains("vrow"))).toHaveLength(3);
    expect(screen.getByRole("button", { name: /^1 Verified$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^1 In progress$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^1 Not checked$/ })).toBeInTheDocument();
    expect(screen.getByText("Checked and working as described.")).toBeInTheDocument();
    expect(rowOf("Demo A").getByRole("button", { name: "Verified" })).toHaveAttribute("aria-pressed", "true");
    expect(rowOf("Demo A").getByLabelText("Note")).toHaveValue("Ran end to end on the mock.");
  });

  it("Save is off until something changes, then sends the status and trimmed note and shows Saved", async () => {
    const f = stubFetch(shelf(), async () => ({ ok: true, json: async () => ({ ok: true, mark: mark("verified", { note: "Checked live", source: "local" }) }) }));
    render(<VerifyPage />);
    await screen.findByText("Demo C", { selector: "b" });
    const row = rowOf("Demo C");
    const save = row.getByRole("button", { name: /Save/ });
    expect(save).toBeDisabled();
    expect(row.getByLabelText("Note")).toBeDisabled(); // no note while Not checked
    fireEvent.click(row.getByRole("button", { name: "Verified" }));
    fireEvent.change(row.getByLabelText("Note"), { target: { value: "  Checked live  " } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(row.getByRole("status")).toHaveTextContent("Saved"));
    const put = f.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put[0]).toBe("/api/verification/c");
    expect(JSON.parse(put[1].body)).toEqual({ status: "verified", note: "Checked live" });
    expect(save).toBeDisabled(); // nothing left to save
    expect(screen.getByRole("button", { name: /^2 Verified$/ })).toBeInTheDocument();
  });

  it("choosing Not checked sends no note", async () => {
    const f = stubFetch(shelf(), async () => ({ ok: true, json: async () => ({ ok: true, mark: null }) }));
    render(<VerifyPage />);
    await screen.findByText("Demo A", { selector: "b" });
    const row = rowOf("Demo A");
    fireEvent.click(row.getByRole("button", { name: "Not checked" }));
    fireEvent.click(row.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(row.getByRole("status")).toHaveTextContent("Saved"));
    expect(JSON.parse(f.mock.calls.find(([, i]) => i?.method === "PUT")[1].body)).toEqual({ status: "none", note: "" });
    expect(screen.getByRole("button", { name: /^2 Not checked$/ })).toBeInTheDocument();
  });

  it("a refused save says why in plain words and keeps the draft", async () => {
    stubFetch(shelf(), async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: "agent-not-running" }) }));
    render(<VerifyPage />);
    await screen.findByText("Demo C", { selector: "b" });
    const row = rowOf("Demo C");
    fireEvent.click(row.getByRole("button", { name: "In progress" }));
    fireEvent.click(row.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(row.getByRole("status")).toHaveTextContent("the start agent is not running"));
    expect(row.getByRole("button", { name: "In progress" })).toHaveAttribute("aria-pressed", "true");
    expect(row.getByRole("button", { name: /Save/ })).toBeEnabled();
  });

  it("an agent started before this feature (no save route) is named in plain words, not as not-found", async () => {
    stubFetch(shelf(), async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: "not-found" }) }));
    render(<VerifyPage />);
    await screen.findByText("Demo C", { selector: "b" });
    const row = rowOf("Demo C");
    fireEvent.click(row.getByRole("button", { name: "Verified" }));
    fireEvent.click(row.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(row.getByRole("status")).toHaveTextContent("older than this page"));
  });

  it("the note box stops at the server's limit", async () => {
    stubFetch(shelf());
    render(<VerifyPage />);
    await screen.findByText("Demo A", { selector: "b" });
    expect(rowOf("Demo A").getByLabelText("Note")).toHaveAttribute("maxlength", "140");
  });

  it("a chip filters the list, and search narrows it", async () => {
    stubFetch(shelf());
    render(<VerifyPage />);
    await screen.findByText("Demo A", { selector: "b" });
    fireEvent.click(screen.getByRole("button", { name: /^1 In progress$/ }));
    expect(screen.queryByText("Demo A", { selector: "b" })).toBeNull();
    expect(screen.getByText("Demo B", { selector: "b" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^3 All$/ }));
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "demo c" } });
    expect(screen.queryByText("Demo A", { selector: "b" })).toBeNull();
    expect(screen.getByText("Demo C", { selector: "b" })).toBeInTheDocument();
  });

  it("when saving is off the controls are disabled and the page says why", async () => {
    stubFetch(shelf({ verificationEditable: false }));
    render(<VerifyPage />);
    await screen.findByText("Demo A", { selector: "b" });
    expect(screen.getByText(/Saving is off on this shelf/)).toBeInTheDocument();
    expect(rowOf("Demo A").getByRole("button", { name: "Verified" })).toBeDisabled();
  });
});
