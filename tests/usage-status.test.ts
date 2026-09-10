import { test, expect } from "bun:test";
import { Container, type Terminal } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Status } from "../src/tui/status";
import { mkEvent } from "../src/events";
import { createTuiApp } from "../src/tui/app";
import { FakeProvider } from "../src/providers/fake";
import { SessionStore } from "../src/session";
import type { ModelProfile } from "../src/profiles";
import { Workspace } from "../src/tools/workspace";
import { Rules } from "../src/rules";

const profile: ModelProfile = { id: "fixture", model: "fixture-model", provider: "openai-compat", contextTokens: 32768, maxToolSurface: 0, parser: "native", streamingTools: false };
const counts = { input_tokens: 70, output_tokens: 15, reasoning_tokens: 4, cache_read_tokens: 20, cache_write_tokens: 10 };
const usage = () => mkEvent("usage", { turn: "t", provider: "fixture", model: "fixture-model", ...counts });

test("status displays only known session totals, without counting reasoning twice", () => {
  let renders = 0;
  const status = new Status(new Container(), () => renders++);
  status.setSession("first");
  expect(status.renderLine(200).join("")).not.toContain("tokens");
  status.addUsage(usage());
  expect(status.renderLine(200).join("")).toContain("known tokens 115");
  status.addUsage(usage());
  expect(status.renderLine(200).join("")).toContain("known tokens 230");
  expect(renders).toBe(3);
  status.setProfile(profile);
  expect(status.renderLine(200).join("")).toContain("known tokens 230");
  status.setSession("second", [usage()]);
  expect(status.renderLine(200).join("")).toContain("known tokens 115");
  status.setSession("first");
  expect(status.renderLine(200).join("")).not.toContain("tokens");
  status.addUsage(mkEvent("usage", { turn: "t", provider: "fixture", model: "fixture-model", input_tokens: 0, output_tokens: 0 }));
  expect(status.renderLine(200).join("")).toContain("known tokens 0");
});

function terminal(): Terminal {
  return { start() {}, stop() {}, async drainInput() {}, write() {}, columns: 160, rows: 24, kittyProtocolActive: false,
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 250; i++) { if (check()) return; await Bun.sleep(2); }
  throw new Error("usage status did not update");
}

test("real TUI wiring restores totals on boot/resume, accumulates live events, and preserves them across model swaps", async () => {
  const root = mkdtempSync(join(tmpdir(), "raziel-usage-tui-"));
  const previous = process.env.RAZIEL_HOME;
  process.env.RAZIEL_HOME = root;
  const store = new SessionStore("first");
  store.append(usage());
  const second = new SessionStore("second");
  second.append(mkEvent("user_message", { text: "old unmetered turn" }));
  const rulesPath = join(root, "rules.json");
  const app = createTuiApp({ terminal: terminal(), provider: new FakeProvider([["reply"], ["unmetered"]], [counts]), store, profile,
    registryFull: new Map(), ws: new Workspace(root), rules: Rules.load(rulesPath), rulesPath,
    providerForFn: () => new FakeProvider([["reply"]], [counts]),
  });
  app.surface.start();
  try {
    const handles = await app.ready;
    const line = () => handles.status.renderLine(200).join("");
    expect(line()).toContain("known tokens 115");
    handles.editor.onSubmit?.("hi");
    await waitFor(() => store.replay().some((e) => e.type === "turn_end"));
    expect(line()).toContain("known tokens 230");
    handles.editor.onSubmit?.("unmetered");
    await waitFor(() => store.replay().filter((e) => e.type === "turn_end").length === 2);
    expect(line()).toContain("known tokens 230");
    const before = handles.engineBox.current;
    handles.editor.onSubmit?.("/model sonnet");
    await waitFor(() => handles.engineBox.current !== before);
    expect(line()).toContain("known tokens 230");
    handles.editor.onSubmit?.("/session second");
    await waitFor(() => handles.storeBox.current.id === "second");
    expect(line()).not.toContain("tokens");
    handles.editor.onSubmit?.("/session first");
    await waitFor(() => handles.storeBox.current.id === "first");
    expect(line()).toContain("known tokens 230");
    handles.editor.onSubmit?.("/quit");
    await handles.loopDone;
  } finally {
    app.surface.stop();
    if (previous === undefined) delete process.env.RAZIEL_HOME; else process.env.RAZIEL_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
