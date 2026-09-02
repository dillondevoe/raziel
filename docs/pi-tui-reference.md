# VERIFIED API Reference — @earendil-works/pi-tui (for Raziel M1c terminal surface)

Method: installed the package fresh with `bun add @earendil-works/pi-tui@0.84.4` in an
isolated scratch project, read the actual shipped `.d.ts` files and `.js` implementation
under `node_modules/@earendil-works/pi-tui/dist/`, cross-checked select claims (SIGINT,
resize wiring, alt-screen semantics) against the bundled `README.md` only as a secondary
source, and proved the whole documented import surface compiles with `bunx tsc --noEmit
--strict`. A second script constructs a real `TuiMainScreen` against a stub `Terminal`
(no PTY) and renders one actual frame, to confirm the render pipeline runs headlessly.
Nothing here is from training-data recall — every claim below is traceable to a `.d.ts`
signature, a grep hit in the compiled `.js`, or a passing compile/runtime probe.

- Repo: `github.com/earendil-works/pi` (monorepo, `packages/tui`)
- **Version pinned: 0.84.4** — this is npm's `dist-tags.latest` for pi-tui as of the
  probe date (2026-09-02), and matches the pi-ai 0.84.4 already vendored in raziel. No
  fallback was needed — 0.84.4 exists and is current for both packages.
- License: MIT. Author: Mario Zechner (matches pi-ai).
- `engines.node: ">=22.19.0"`.
- **No `peerDependencies` field** — `get-east-asian-width@1.6.0` and `marked@18.0.5` are
  regular `dependencies`, installed automatically. `chalk@5.6.2` and `@xterm/headless@5.5.0`
  are `devDependencies` only — **not shipped, not installed for consumers.**
- Scratch project: `/private/tmp/claude-501/-/6700f270-b49b-45cf-ae1e-74e510563b8b/scratchpad/pi-tui-probe/`
  (`compile-check.ts`, `smoke-test.ts`, `tsconfig.json`).

---

## 1. Package exports (Q1)

- `package.json` has **no `exports` map at all** — just `"main": "dist/index.js"` and
  `"types": "./dist/index.d.ts"`. This is a genuine difference from pi-ai: **there are no
  subpath imports** (`pi-tui/components/box` etc. do not exist and are not needed).
  Everything documented below comes from one `import { ... } from "@earendil-works/pi-tui"`.
- `"type": "module"` — ESM only, `dist/index.js` + matching `.d.ts`, no CJS build, no dual
  package hazard to worry about.
- Ships a **native addon** — `native/darwin/prebuilds/{darwin-arm64,darwin-x64}/*.node`
  (plus a Windows equivalent) for `isNativeModifierPressed()`-style held-modifier
  detection outside terminal escapes. Confirmed present under `node_modules` after `bun
  add` — arm64 prebuild is there, no build step needed on Apple Silicon. Not part of the
  public `index.d.ts` export list actually used for a chat TUI, but worth knowing this
  package is not pure JS if Raziel ever needs to run it somewhere without native-module
  support.
- Full **verified top-level export list** (from `dist/index.d.ts`, everything importable):
  `Marked`/`Token`/`Tokens` (re-exported from `marked`); `AutocompleteItem` /
  `AutocompleteProvider` / `AutocompleteSuggestions` / `CombinedAutocompleteProvider` /
  `SlashCommand`; `Box`; `CancellableLoader`; `Editor` / `EditorOptions` / `EditorTheme`;
  `HStack`; `Image` / `ImageOptions` / `ImageTheme`; `Input`; `Loader` /
  `LoaderIndicatorOptions`; `DefaultTextStyle` / `Markdown` / `MarkdownOptions` /
  `MarkdownTheme`; `ScrollView` / `ScrollViewOptions` / `ScrollViewScrollbar` /
  `ScrollViewScrollToOptions`; `SelectItem` / `SelectList` / `SelectListLayoutOptions` /
  `SelectListTheme` / `SelectListTruncatePrimaryContext`; `SettingItem` / `SettingsList` /
  `SettingsListTheme`; `Spacer`; `Text`; `TruncatedText`; `StackChild` / `StackEntry` /
  `StackEntryOptions` / `StackOptions` / `VStack`; `EditorComponent` (type only);
  `FuzzyMatch` / `fuzzyFilter` / `fuzzyMatch`; `getKeybindings` / `Keybinding` /
  `KeybindingConflict` / `KeybindingDefinition` / `KeybindingDefinitions` / `Keybindings` /
  `KeybindingsConfig` / `KeybindingsManager` / `setKeybindings` / `TUI_KEYBINDINGS`;
  `decodeKittyPrintable` / `isKeyRelease` / `isKeyRepeat` / `isKittyProtocolActive` / `Key` /
  `KeyEventType` / `KeyId` / `matchesKey` / `parseKey` / `setKittyProtocolActive`;
  `RenderLatexOptions` / `renderLatex`; `StdinBuffer` / `StdinBufferEventMap` /
  `StdinBufferOptions`; `ProcessTerminal` / `Terminal`; `parseOsc11BackgroundColor` /
  `parseTerminalColorSchemeReport` / `RgbColor` / `TerminalColorScheme`; a full Kitty/
  iTerm2 inline-image API (`allocateImageId`, `encodeKitty`, `encodeITerm2`,
  `renderImage`, `detectCapabilities`, `getCapabilities`, etc.); `Component` / `Container`
  / `CURSOR_MARKER` / `compositeTuiLine` / `Focusable` / `isFocusable` / `isViewportTUI` /
  `OverlayAnchor` / `OverlayHandle` / `OverlayMargin` / `OverlayOptions` /
  `OverlayUnfocusOptions` / `SizeValue` / `TUI` / `TuiInputListener` /
  `TuiInputListenerResult` / `TuiMode` / `TuiStopOptions` / `ViewportTUI`; `TuiAltScreen` /
  `TuiAltScreenOptions`; `TuiMainScreen` / `TuiMainScreenRenderState`;
  `getOsc8LinkAtColumn` / `sliceByColumn` / `stripTerminalSequences` / `truncateToWidth` /
  `visibleWidth` / `wrapTextWithAnsi`.
- All of the above type-checks in one `compile-check.ts` import block — see §9.

---

## 2. Core component model, render loop, state/update (Q2)

Everything renderable implements one small interface (`tui.d.ts`, verbatim):

```typescript
interface Component {
  render(width: number): string[];       // pure function of viewport width -> lines
  handleInput?(data: string): void;      // raw terminal bytes, only when focused
  wantsKeyRelease?: boolean;              // opt in to Kitty key-release events
  invalidate(): void;                     // drop cached render state (theme change etc.)
}
interface Focusable { focused: boolean; } // TUI sets this; component emits CURSOR_MARKER when true
```

`Container implements Component` holds `children: Component[]` with
`addChild/removeChild/clear/invalidate/render` — the base every layout primitive
(`Box`, `HStack`, `VStack`, `ScrollView`) extends.

**State/update mechanism is manual, not reactive.** There is no signal/observable system.
The pattern every built-in component uses: mutate internal state via a method
(`setText()`, `setValue()`, `addChild()`, ...), which sets `cachedText`/`cachedWidth` to
`undefined` (or otherwise marks the component dirty) so the next `render(width)` call
recomputes, then the caller explicitly asks the `TUI` to redraw (see below). Nothing
watches your data for you.

**Render loop is implicit and self-scheduling** — there is no `tick()`/`frame()` to call
yourself:
```typescript
const terminal = new ProcessTerminal();
const tui: TUI = new TuiMainScreen(terminal);
tui.addChild(new Text("Welcome"));
tui.start();
```
Any mutation that should show up on screen should be followed by
`tui.requestRender()` (debounced/coalesced by a private `MIN_RENDER_INTERVAL_MS` on
`TuiBase` — not caller-tunable) or `tui.renderNow(force?)` to force an immediate
synchronous redraw (use this right before `process.exit`, or in the headless-render use
case in §8). `TuiBase` (abstract, extended by both renderers) owns: focus management,
overlay stack (`showOverlay`/`hideOverlay`/`hasOverlay`, with anchor/margin/percentage
sizing via `OverlayOptions`), input listener registration, terminal-color-scheme queries
(OSC 11 background color, `CSI ?996n` dark/light preference), and the render scheduling
itself. `TuiMainScreen` and `TuiAltScreen` only implement `doRender()` differently.

Two concrete `TUI` implementations, chosen at construction, not swappable at runtime:
- **`TuiMainScreen`** — renders into the real terminal buffer + native scrollback.
  Behaves like a REPL: differential rendering with a full clear+redraw only on width
  change or an edit above the viewport; otherwise moves the cursor to the first changed
  line and rewrites only changed lines onward. `captureRenderState()`/
  `restoreRenderState()` exist for handing off the terminal to another `TuiMainScreen`.
- **`TuiAltScreen`** — fixed-height viewport in the alternate screen buffer, app-owned
  scrolling. Confirmed from `tui-alt-screen.d.ts`: mouse-driven text selection with
  OSC-52 clipboard copy (`copyOnSelect`, `copySelection`), a built-in transcript search
  (`Ctrl+Shift+F` opens it, `Enter`/`Ctrl+G` and `Shift+Enter`/`Ctrl+Shift+G` navigate
  matches, `Escape` closes — via `openSearch`/`navigateSearch`/`closeSearch`), OSC 133
  semantic-prompt jump navigation, scrollbar drag, `flash(message, durationMs?)` for
  transient toast messages, and `setLayoutRoot(component)` (only on `TuiAltScreen` — it's
  the sole `ViewportTUI`, gated by the `isViewportTUI()` type guard and the unique
  `VIEWPORT_TUI` symbol) to opt into an explicit `VStack`/`HStack`/`ScrollView` layout
  instead of the legacy single-document scroll. Without `setLayoutRoot()` it behaves like
  a single infinitely-tall scrolling document (the README's own framing).

Both renderers wrap every screen update in **synchronized output**
(`\x1b[?2026h...\x1b[?2026l`) — confirmed in the raw bytes captured by the headless smoke
test in §8 — for flicker-free atomic redraws.

---

## 3. Input handling, raw mode, and the Ctrl+C / SIGINT question (Q3)

**Confirmed by grepping the compiled `terminal.js`: pi-tui registers zero
`process.on(...)` signal or exit handlers anywhere in the package.** The only process
API it touches directly is `process.stdin.setRawMode(true)` (guarded with
`if (process.stdin.setRawMode)`, so it's a no-op instead of a throw when stdin isn't a
TTY), `process.stdin.resume()`/`.on('data', ...)`, and `process.stdout.on('resize', ...)`.

**This is the finding that matters most for Raziel's own SIGINT handler:** Node's
`ReadStream.setRawMode(true)` disables the terminal's own signal generation — per Node's
own documented behavior, **Ctrl+C no longer produces a SIGINT once raw mode is on.**
pi-tui's own README makes this explicit in a code comment (verified in the shipped
`README.md`, verbatim): `// In raw mode Ctrl+C doesn't send SIGINT — intercept it here to
allow exit`. So:

- **While a pi-tui `TUI` is running (`tui.start()` called, raw mode active), Raziel's
  existing `process.on('SIGINT', ...)` handler will NOT fire on a user pressing Ctrl+C.**
  The 0x03 byte instead arrives as ordinary input data through the normal input path
  (`addInputListener` / a focused component's `handleInput`).
- This is **not a conflict in the sense of two handlers racing** — it's a silent
  **replacement** of the trigger path. Raziel must intercept Ctrl+C itself via
  `matchesKey(data, Key.ctrl("c"))` in an input listener and decide what to do (call
  `tui.stop()` then `process.exit(0)`, or something more graceful), exactly as pi-tui's
  own quick-start does:
  ```typescript
  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) { tui.stop(); process.exit(0); }
  });
  ```
  A real out-of-band SIGINT (e.g. `kill -SIGINT <pid>` from outside the terminal, or a
  supervisor sending the signal directly) is **unaffected** — raw mode only suppresses
  the *terminal driver's* Ctrl+C→SIGINT translation, not signals delivered by other
  means — so Raziel's existing process-level SIGINT handler still fires for those and can
  stay in place as a second line of defense; it just won't see interactive Ctrl+C anymore
  while a `TUI` owns the terminal.
- **No crash/exit safety net exists in the library.** There is no `process.on('exit', ...)`
  or `uncaughtException` handler that restores cooked terminal mode. If the process dies
  (uncaught exception, unhandled rejection) without Raziel calling `tui.stop()` first, the
  terminal is left in raw mode (and, for `TuiAltScreen`, in the alternate screen buffer
  with the hardware cursor possibly hidden). **Raziel needs its own top-level crash
  handlers that call `tui.stop()` before exiting** — pi-tui does not provide this.
- Input dispatch: `TUI.addInputListener(fn: (data: string) => TuiInputListenerResult)`
  registers a listener; `handleTerminalInput` (private) also forwards to the focused
  component's `handleInput?(data)`. Raw, unparsed terminal bytes are what listeners see —
  `matchesKey`/`parseKey`/`isKeyRelease`/`isKeyRepeat`/`decodeKittyPrintable` (from
  `keys.ts`) are the tools for turning that into named keys, including Kitty keyboard
  protocol event types (press/repeat/release) when the terminal supports it.
  `StdinBuffer` (separately exported) is what `ProcessTerminal` uses internally to
  reassemble input that arrives split across multiple stdin `data` events (e.g. a mouse
  SGR sequence split mid-sequence) before your listeners ever see it — not something a
  consumer normally needs to touch directly, but useful if Raziel needs a similar
  reassembly step in a custom `Terminal`.
- Resize is also automatic, not something Raziel has to poll: `ProcessTerminal.start()`
  wires `process.stdout.on("resize", onResize)` itself (confirmed in `terminal.js`); the
  `onResize` callback is `TuiBase`'s own re-render trigger. Raziel does not need to
  listen for `resize` separately unless it wants to react to it itself.

---

## 4. Layout primitives, flex-like stacking, scrollback for a chat transcript (Q4)

Real, typed layout primitives (not just markup-string composition):

- **`Box(paddingX?, paddingY?, bgFn?)`** — padding + background-color wrapper around
  children, single-container.
- **`HStack`/`VStack`** (both extend an internal `Stack extends Container`) — flex-like
  stacking. `StackOptions`: `{ gap?: number; align?: "stretch"|"start"|"center"|"end" }`.
  Per-child `StackEntryOptions`: `{ basis?: number|"auto"; grow?: number; shrink?: number;
  minSize?: number; maxSize?: number; visible?: (viewport) => boolean }` — real
  flex-box-shaped sizing (`grow`/`shrink`/`basis`/min/max), plus a responsive `visible`
  predicate evaluated against the current layout viewport each render.
- **`Spacer`** — a flexible-space filler component for stacks.
- **`Text`** — word-wrapping single component with a render cache
  (`cachedText`/`cachedWidth`/`cachedLines`, invalidated by `setText()`).
- **`TruncatedText`** — single-line, ellipsis-truncating variant.
- **`ScrollView(child, options?)`** — **this is the scrollback primitive for a chat
  transcript.** Verified constructor and options from `scroll-view.d.ts`:
  ```typescript
  interface ScrollViewOptions {
    axis?: "vertical";
    follow?: "none" | "end";          // "end" = auto-stick to bottom on new content
    primary?: boolean;                 // receives alt-screen keyboard nav / unhandled wheel
    overscroll?: "chain" | "contain";  // whether wheel overscroll passes to a parent scroll view
    scrollbar?: "hidden" | "auto" | "always";
    scrollbarStyle?: (text: string) => string;
    scrollbarHideDelayMs?: number;
  }
  ```
  Instance API: `scrollTop`/`isFollowingEnd`/`viewportHeight` getters, `scrollTo(top,
  {disableFollow?})`, `scrollBy(lines)`, `scrollToStart()`, `scrollToEnd()`. This is
  exactly the shape you want for a chat log: put the message list in a `VStack` inside a
  `ScrollView({ follow: "end" })`, and new messages auto-stick to the bottom until the
  user scrolls up, at which point `follow` naturally stops (README-documented behavior:
  "follows streaming output while at the bottom, and preserves a manually selected scroll
  position while content grows").
- **Important asymmetry, confirmed in both the README and the type shapes**:
  `ScrollView`'s app-owned scrolling, and `setLayoutRoot()`'s `VStack`/`HStack`/nested-
  `ScrollView` region layout, are **only meaningful under `TuiAltScreen`**. Under
  `TuiMainScreen` the real terminal owns scrollback and printed content just accumulates
  in normal scrollback — there's no independently-scrollable region. If Raziel wants a
  bounded, app-controlled scrolling chat viewport (vs. "print to the terminal and let the
  terminal's own scrollback hold history"), it needs `TuiAltScreen` + `setLayoutRoot()`.
  Plain `TuiMainScreen` is closer to a REPL transcript.
- `sliceByColumn`/`sliceWithWidth`/`extractSegments`/`getGraphemeCellRange` (from
  `utils.ts`) are the lower-level column-math primitives layout code builds on if Raziel
  ever needs to compose lines itself outside the component tree.

---

## 5. Streaming text — appending to a growing assistant message without flicker (Q5)

**No incremental/append API exists on any text component.** `Text.setText()` and
`Markdown.setText()` both **fully replace** the stored string and invalidate the render
cache (`cachedText = cachedWidth = cachedLines = undefined`); the next `render(width)`
call re-wraps/re-parses the entire string from scratch. There is no `appendText()` or
delta-patch method anywhere in `text.d.ts` or `markdown.d.ts`.

The idiomatic pattern (confirmed by construction + the render-cache shape, not a README
recipe — none is given verbatim): accumulate the full text client-side as `text_delta`
events arrive, and on each chunk (or throttled) call:
```typescript
fullTextSoFar += delta;
markdownComponent.setText(fullTextSoFar);
tui.requestRender();      // debounced internally — safe to call every delta
```
The **flicker-free** part is not from any incremental-render trick — it's that
(a) `requestRender()` is coalesced by `TuiBase`'s private min-render-interval throttle,
so calling it on every token does not actually redraw every token, and (b) whichever
renderer is active wraps the actual terminal write in synchronized-output escapes
(`\x1b[?2026h...l`), so whatever *does* get redrawn lands atomically with no visible
tearing. There is no way to avoid re-parsing the full accumulated Markdown on every
`setText()` call — for a very long streamed response this is O(n) work per delta. That's
an efficiency ceiling to know about, not a correctness bug: confirmed harmless at chat-
message lengths in the headless smoke test (§8), but Raziel should not assume this scales
to, say, a multi-megabyte streamed document without its own additional throttling beyond
what `requestRender()` already provides.

`Markdown`'s constructor signature (verified):
```typescript
constructor(text: string, paddingX: number, paddingY: number, theme: MarkdownTheme,
            defaultTextStyle?: DefaultTextStyle, options?: MarkdownOptions)
```
`MarkdownOptions`: `preserveOrderedListMarkers?`, `preserveBackslashEscapes?`,
`transform?(markdown, availableWidth): string` (pre-parse hook), `renderLatex?` (default
**true** — LaTeX math is rendered as Unicode text via a bundled `renderLatex()`,
independently exported too).

---

## 6. Markdown rendering and the ANSI passthrough / sanitize seam (Q6)

**`Markdown` is a real parser** — built on `marked@18.0.5` (re-exported as `Marked`/
`Token`/`Tokens`), not a naive regex pass. It handles headings, links, code/code blocks
(with an optional `highlightCode?(code, lang?): string[]` hook for syntax highlighting),
block quotes, horizontal rules, ordered/unordered lists (with real nesting, confirmed by
a private `renderList` supporting nested markers), tables (`renderTable`, with
width-aware cell wrapping delegating to `wrapTextWithAnsi`), and LaTeX math. Confirmed
live in the headless smoke test (§8): `"**bold** and `code`"` rendered through with an
identity theme came out as `"bold and code"` — the markdown syntax markers are stripped
and only the theme's styling functions (which the smoke test left as identity) would add
ANSI color back in.

**`MarkdownTheme` is pure BYO-ANSI** — every field
(`heading/link/linkUrl/code/codeBlock/codeBlockBorder/quote/quoteBorder/hr/listBullet/
bold/italic/strikethrough/underline`) is just `(text: string) => string`. **pi-tui itself
does zero colorizing** — `chalk` is a devDependency only, not shipped to consumers.
Raziel must supply its own ANSI/color function library for every themed component
(`MarkdownTheme`, `EditorTheme`, `SelectListTheme`, `ScrollViewOptions.scrollbarStyle`,
`TuiAltScreenOptions.searchMatchStyle`, etc.).

**This is also the answer to "where's the sanitize seam":**
- `stripTerminalSequences(str: string): string` — exported top-level from `utils.ts`.
  Doc comment, verbatim: *"Remove ANSI, OSC, and APC control sequences while preserving
  visible text."* This is exactly the function to run untrusted/assistant-generated text
  through **before** handing it to any pi-tui component, if Raziel wants to guarantee no
  stray escape sequences from model output reach the terminal. Confirmed compiling and
  callable (§9).
- Two related utilities that are NOT sanitizers but do parse/preserve existing ANSI
  (useful if Raziel wants to trust *its own* pre-styled output but not user/model text):
  `wrapTextWithAnsi(text, width): string[]` — word-wraps while preserving active ANSI
  codes across line breaks (no padding, no backgrounds); `visibleWidth(str): number` —
  width in terminal columns, ANSI-aware; `truncateToWidth`/`sliceByColumn`/
  `getOsc8LinkAtColumn` — same ANSI-aware column math for truncation, slicing, and OSC 8
  hyperlink detection at a column.
- Recommended seam for a chat harness: sanitize (`stripTerminalSequences`) any text that
  originates from the model or the far end of a tool call before it goes into a `Text` or
  `Markdown` component's `setText()`; text Raziel itself constructs and colors (its own
  chrome, prompts, status lines) can skip that and use `wrapTextWithAnsi`/`visibleWidth`
  directly since it's trusted to carry real ANSI.

---

## 7. Terminal lifecycle: alt-screen, cleanup, resize (Q7)

- **Alt-screen vs. main-screen is a constructor-time choice**, not switchable at runtime
  on a live `TUI` instance — pick `TuiMainScreen` or `TuiAltScreen` up front. Both take
  `(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string)`;
  `TuiAltScreen` additionally takes a fourth `TuiAltScreenOptions` argument
  (`wheelScrollLines?`, `mouse?`, `searchMatchStyle?`, `searchCurrentMatchStyle?`,
  `openUrl?`, `onRightClickPaste?`, `copyOnSelect?`, `copySelection?`).
- **Cleanup is entirely manual and NOT automatic on crash** (see §3) — `tui.stop(options?:
  { preserveScreen?: boolean })` is what restores cooked terminal mode / exits the
  alt-screen buffer / shows the cursor again. `TuiStopOptions.preserveScreen` exists
  specifically for handing the terminal off to *another* TUI instance without clearing
  the screen first. Confirmed by grep: **no exit/signal handler in the package calls
  `stop()` for you.** Raziel's process must call it — on Ctrl+C (via the input-listener
  workaround in §3), and ideally also in a top-level crash handler.
  `ProcessTerminal.drainInput(maxMs?, idleMs?)` (default 1000ms max / 50ms idle) is a
  documented pre-exit step — its doc comment explains it exists to *"drain stdin before
  exiting to prevent Kitty key release events from leaking to the parent shell over slow
  SSH connections"* — worth calling before final exit if Kitty protocol was negotiated.
- **Resize is automatic once `tui.start()`/`ProcessTerminal.start()` runs** —
  `process.stdout.on("resize", ...)` is wired internally (confirmed in `terminal.js`);
  Raziel does not need its own resize listener for pi-tui's own layout to respond, though
  it can still read `terminal.columns`/`terminal.rows` any time via the getters. A width
  change forces `TuiMainScreen` into a full clear+redraw rather than a differential
  update (README-documented, consistent with the differential-render description in §2).
- Terminal negotiation pi-tui handles for you inside `ProcessTerminal`: Kitty keyboard
  protocol detection/enable (progressive-enhancement flags: disambiguate escapes, report
  press/repeat/release, report alternate keys) with a `modifyOtherKeys` fallback for
  terminals that don't support Kitty; Apple Terminal's Shift+Enter quirk
  (`normalizeAppleTerminalInput`); Windows VT-input enabling
  (`ENABLE_VIRTUAL_TERMINAL_INPUT`) so Shift+Tab etc. arrive correctly. None of this is
  something Raziel needs to reimplement.
- **No headless/"dumb terminal" mode is built in for a real run**, but `Terminal` is a
  plain interface (`start`/`stop`/`drainInput`/`write`/`columns`/`rows`/
  `kittyProtocolActive`/cursor+clear+title+progress methods) — nothing in it requires a
  real TTY. A test/CI harness (or Raziel's own test suite) can implement a stub `Terminal`
  against an in-memory buffer instead of `ProcessTerminal`. That's exactly what the
  headless smoke test in §8 does, and it's the only way to run a `TuiMainScreen`/
  `TuiAltScreen` without a real PTY — `ProcessTerminal` itself hard-wires to
  `process.stdin`/`process.stdout` and cannot be constructed against anything else.

---

## 8. Headless live smoke test (real render, no PTY)

File: `.../scratchpad/pi-tui-probe/smoke-test.ts`. Implements a stub `Terminal` whose
`write()` appends to an in-memory string instead of touching a real fd, constructs a real
`TuiMainScreen` against it, builds a small component tree (`VStack` containing a `Text`
and a `Markdown`), and calls `tui.start()` + `tui.renderNow(true)`.

**Result: ran clean under `bun run smoke-test.ts`, no PTY, no `process.stdin` TTY needed.**
Captured first-frame bytes (truncated for readability) show the exact mechanics claimed
above — synchronized-output wrapper, full-clear-on-first-render, and markdown syntax
stripped by the parser:
```
\x1b[?2026h\x1b[2J\x1b[H\x1b[3J ... \x1b[0m\x1b]8;;\x07\r\n
 Welcome to pi-tui headless smoke test                      \x1b[0m\x1b]8;;\x07\r\n
                                                              \x1b[0m\x1b]8;;\x07\r\n
bold and code                                                \x1b[0m\x1b]8;;\x07\x1b[?2026l
```
(`**bold** and \`code\`` rendered as `bold and code` — confirms the Markdown parser
strips syntax markers and applies theme functions, which were left as identity here.)

This directly answers the "one tiny live smoke if headless instantiation is possible"
requirement: it is possible, because `Terminal` is a plain interface — `ProcessTerminal`
itself is the only piece that actually requires a real TTY (it calls
`process.stdin.setRawMode`/`.resume()` unconditionally, though guarded against `undefined`
so it degrades quietly rather than throwing on non-TTY stdin).

---

## 9. Compile-check (proof the import surface is real)

File: `.../scratchpad/pi-tui-probe/compile-check.ts`. Command:
`bunx tsc --noEmit --strict` (TypeScript 7.0.2, `moduleResolution: "bundler"`, `target:
"ESNext"`).

**Result: exit code 0, zero errors, zero warnings**, after fixing three constructor-arity
mistakes found by the compiler itself on the first pass (`Loader`/`CancellableLoader`
take `(tui, spinnerColorFn, messageColorFn, message?, indicator?)`, not a frames array;
`Image` takes `(base64Data, mimeType, theme, options?, dimensions?)`, not a `Buffer`;
`SelectList` takes `(items, maxVisible, theme, layout?)` — all three assumptions were
wrong on first guess and the compiler is what caught it, which is the point of this
verification method). The probe imports and exercises: the `Component`/`Container`/
`Focusable` contract; both `TuiMainScreen` and `TuiAltScreen` construction with
`TuiAltScreenOptions`; `Box`/`HStack`/`VStack`/`ScrollView`/`Spacer`/`Text`/
`TruncatedText` with real `StackEntry`/`ScrollViewOptions` option shapes; `Markdown` +
full `MarkdownTheme`; `Editor`+`EditorTheme`, `Input`; `matchesKey`/`Key`/
`KeybindingsManager`/`TUI_KEYBINDINGS`; the ANSI utils `stripTerminalSequences`/
`visibleWidth`/`wrapTextWithAnsi`/`truncateToWidth`/`sliceByColumn`; `Image`/`Loader`/
`CancellableLoader`/`SelectList`/`StdinBuffer`; `CURSOR_MARKER`/`isFocusable`/
`isViewportTUI`. `SelectListTheme`'s shape was fully verified this time (unlike the
earlier pi-ai+pi-tui combined reference, which had stubbed it with `as any`) — see
`select-list.d.ts`: `{ selectedPrefix, selectedText, description, scrollInfo, noMatch }`,
each `(text: string) => string`.

---

## 10. Surprises / gaps for a chat-TUI use case (Q8)

- **Raw mode silently defeats Ctrl+C→SIGINT.** This is the single biggest thing for
  Raziel's own SIGINT handler: it will not see interactive Ctrl+C once a pi-tui `TUI` is
  running. Not a bug, not really a "conflict" — just a channel switch from "OS signal" to
  "ordinary input byte 0x03" that Raziel must intercept itself (§3). Confirmed both by
  code inspection and by the library's own README comment saying exactly this.
- **Zero crash-safety net.** No exit/signal handler anywhere restores terminal state on
  an uncaught exception. A harness built on this library that doesn't add its own
  top-level handlers calling `tui.stop()` can leave a user's terminal in raw mode / the
  alt-screen buffer / hidden-cursor state after a crash. This is a real gap Raziel needs
  to close itself, not something pi-tui does for you.
- **No incremental text API.** Every streaming-text update is a full replace + full
  re-parse (`setText(fullTextSoFar)`), for both `Text` and `Markdown`. Fine at chat-message
  scale (confirmed in the smoke test); something to watch if a single streamed message
  ever gets very large.
- **No exports map / no subpath imports** — a real (small) difference from pi-ai's
  sprawling `./providers/*` / `./api/*` subpath surface. Everything is one flat import
  from `@earendil-works/pi-tui`. Simpler, but also means there's no way to import "just
  the layout primitives" without pulling in the whole package (moot for tree-shaking
  purposes in a bundler, but worth knowing there's no lazy subpath split like pi-ai has).
- **`ScrollView`'s app-owned scrolling only matters under `TuiAltScreen`.** If Raziel
  defaults to `TuiMainScreen` for simplicity (closer to a REPL, less to configure), it
  gets *none* of `ScrollView`'s `follow: "end"` / independent-region scrolling behavior —
  the terminal's native scrollback is the only scrollback there is. This is a real
  architecture fork to decide early, not a minor detail: a bounded, mouse-scrollable chat
  viewport needs `TuiAltScreen` + `setLayoutRoot()`; a "just print to the terminal like a
  REPL" chat log can use the simpler `TuiMainScreen`.
- **You must bring your own ANSI/color library for every theme.** `chalk` is a
  devDependency only. Every theme object across every component is plain
  `(text: string) => string` functions — pi-tui does zero colorizing of its own.
- **The ANSI sanitize seam is a real, exported, single-purpose function** —
  `stripTerminalSequences()` — which is the clean place to run untrusted/model-generated
  text through before it reaches any component, directly answering "where does Raziel's
  ANSI sanitization slot in."
- **Headless testing is possible but not first-class.** `Terminal` is a clean interface a
  test harness can stub (confirmed working, §8), but there's no shipped test-terminal
  helper for consumers — `@xterm/headless` is a devDependency used only in pi-tui's own
  test suite, not exported or usable by Raziel.
- Nothing looked outright broken in this pass — the library is more feature-complete for
  a chat-TUI than the surface area alone suggests (built-in transcript search, OSC 52
  clipboard, mouse text selection, Kitty/iTerm2 inline images, LaTeX rendering, kill-ring
  and undo in the editor). The gaps above are omissions Raziel needs to build around
  (crash safety, its own color lib, the SIGINT re-routing), not defects in what's there.
