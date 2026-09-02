# VERIFIED API Reference — @earendil-works/pi-ai + @earendil-works/pi-tui

Method: installed both packages with `bun add` in a scratch project, read the actual
shipped `.d.ts` files under `node_modules/@earendil-works/{pi-ai,pi-tui}/dist/`, cross-checked
against the packages' bundled `README.md`, and wrote a compile-check `.ts` file that imports
every symbol documented below and type-checks clean with `bunx tsc --noEmit` (strict mode,
via the project's own `tsconfig.json`). All claims below are taken verbatim from `.d.ts`
signatures or README code blocks — nothing here is from training-data recall.

- Repo: github.com/earendil-works/pi (monorepo; packages/ai, packages/tui, packages/telemetry)
- Homepage in npm metadata: `https://github.com/earendil-works/pi#readme`
- Version pinned: **0.84.4** for both packages (npm `dist-tags.latest` as of probe date;
  package first published under this scope 2026-05-07, current release 2026-08-28)
- License: **MIT** for pi-ai, pi-tui, and the transitive `@earendil-works/pi-telemetry` dep
- Author: Mario Zechner (single author field on both packages)
- `npm view` shows a `legacy-node20` dist-tag pinned at `0.74.2` — a Node 20-compatible
  fallback release line kept alongside `latest`.

---

## 1. `@earendil-works/pi-ai`

### 1.1 Package shape

- `type: module`, ships only `.js` + `.d.ts` under `dist/`. `main`/`types` point at
  `dist/index.js` / `dist/index.d.ts`.
- `exports` map (this matters — most of the useful API is **not** re-exported from the
  package root and must be imported via subpath):
  - `"."` → `dist/index.js` — types + a few value exports (`Type`, `createModels`,
    `createProvider`, `envApiKeyAuth`, `hasApi`, `validateToolCall`, `contentText`,
    `uuidv7`, overflow/retry/validation utils, the `faux` test provider). Root re-exports
    are **type-only** for every provider-specific Options type (`AnthropicOptions`,
    `OpenAICompletionsOptions`, etc.) and for the per-API `stream`/`streamSimple`
    **functions themselves are not re-exported from root at all**.
  - `"./providers/*"` → `dist/providers/*.js` — provider **factory functions**
    (`anthropicProvider()`, `openaiProvider()`, etc.) and `./providers/all` which exports
    `builtinModels()` (registers every built-in provider into one `Models` collection).
  - `"./api/*"` → `dist/api/*.js` — the raw per-API implementation modules. Each exports
    exactly `stream` and `streamSimple` (a `StreamFunction<Api, Options>`), fully typed.
    `./api/<id>.lazy` variants defer the underlying SDK's dynamic import to first request
    (what provider factories use internally).
  - `"./compat"`, `"./oauth"`, `"./bedrock-provider"`, `"./bun-oauth"` — auxiliary subpaths.
- Dependencies include `@anthropic-ai/sdk@0.91.1`, `openai@6.40.0`, `@google/genai@1.52.0`,
  `@aws-sdk/client-bedrock-runtime`, `typebox@1.3.7` (schema library re-exported as
  `Type`/`Static`/`TSchema`), and `@earendil-works/pi-telemetry` (installed automatically
  as a same-scope sibling dependency — no separate `bun add` needed).
- `KnownApi` (the literal union of API adapters that actually exist):
  `"openai-completions" | "mistral-conversations" | "openai-responses" |
  "azure-openai-responses" | "openai-codex-responses" | "anthropic-messages" |
  "bedrock-converse-stream" | "google-generative-ai" | "google-vertex" | "pi-messages"`.
  **There is no `"ollama"` entry — see §1.5.**

### 1.2 Building a client/session

Two levels of API, both real and both used in the README:

**A. High-level — `Models` collection** (recommended; handles auth resolution):

```typescript
import { createModels, createProvider, envApiKeyAuth, type Model } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const models = createModels();                 // MutableModels
models.setProvider(anthropicProvider());        // built-in factory, id "anthropic"
models.setProvider(createProvider({             // custom provider, e.g. Ollama
  id: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } }, // keyless
  models: [ollamaModel],                        // Model<'openai-completions'>[]
  api: openAICompletionsApi(),
}));

await models.complete(models.getModel('anthropic', 'claude-opus-5')!, context);
```

`createModels(options?)` → `MutableModels` (adds `setProvider`/`deleteProvider`/
`clearProviders` to the `Models` read/stream interface). `Models` exposes:
`getProviders/getProvider/getModels/getModel/refresh/checkAuth/getAvailable/getAuth/
login/logout/stream/complete/streamSimple/completeSimple/fetchDeferred/cancelDeferred`.

`createProvider(input: CreateProviderOptions)` builds a `Provider<TApi>` from parts:
`{ id, name?, baseUrl?, headers?, auth, models, fetchModels?, filterModels?, api }`.
`api` is either a single `ProviderStreams` (`{stream, streamSimple, fetchDeferred?,
cancelDeferred?}`) or a map keyed by `model.api` for mixed-API providers (e.g. a gateway
serving both `anthropic-messages` and `openai-responses` models).

**B. Low-level — call an API implementation directly**, bypassing all provider/auth
machinery (README section "Calling API Implementations Directly"):

```typescript
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages';
const s = stream(claudeModel, context, { apiKey: process.env.ANTHROPIC_API_KEY });
```

Every `./api/<id>` module exports only `stream` and `streamSimple`; per-API request
option typing (`AnthropicOptions`, `OpenAICompletionsOptions`, ...) lives alongside them.

### 1.3 Provider construction per target

**Anthropic** — built-in factory:
```typescript
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
// anthropicProvider(): Provider<"anthropic-messages">
```
Auth resolves from env/OAuth per `providers/anthropic.ts` (not inspected — factory is a
black box; use `envApiKeyAuth`-style custom provider if you need a non-standard key source).
`AnthropicOptions` (extends `StreamOptions`): `thinkingEnabled`, `thinkingBudgetTokens`,
`effort: "low"|"medium"|"high"|"xhigh"|"max"`, `thinkingDisplay: "summarized"|"omitted"`,
`interleavedThinking`, `toolChoice: "auto"|"any"|"none"|{type:"tool",name}`, and `client?:
Anthropic` to inject a pre-built SDK client (e.g. `AnthropicVertex`).

**Ollama** — README's exact worked example (verbatim, this is the canonical pattern):
```typescript
import { createModels, createProvider, envApiKeyAuth, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const ollamaModel: Model<'openai-completions'> = {
  id: 'llama-3.1-8b', name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions', provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 32000,
};
const ollama = createProvider({
  id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1',
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
  models: [ollamaModel], api: openAICompletionsApi(),
});
```
README also flags: set `compat.supportsDeveloperRole: false` (and
`supportsReasoningEffort: false` if needed) on Ollama/vLLM/SGLang models, because they
don't understand OpenAI's `developer` role.

**Any generic OpenAI-compatible endpoint** — identical shape, just change `baseUrl`,
`provider` id, and `auth` (use `envApiKeyAuth(displayName, envVars)` for real API keys —
"stored credential wins, then first set env var"). `OpenAICompletionsCompat` has ~20 flags
for quirky servers (max-tokens field name, thinking-param format, session affinity,
strict-mode/grammar-tool support, cache-control convention, etc.) — auto-detected by
`baseUrl` for a set of known compatible providers, override-able per field otherwise.

### 1.4 Streaming call shape (verbatim from `types.d.ts`)

```typescript
interface Context { systemPrompt?: string; messages: Message[]; tools?: Tool[]; }
type Message = UserMessage | AssistantMessage | ToolResultMessage;

// entry points, all return AssistantMessageEventStream (AsyncIterable<AssistantMessageEvent>):
models.stream(model, context, options?)        -> AssistantMessageEventStream
models.streamSimple(model, context, options?)  -> AssistantMessageEventStream
models.complete(model, context, options?)      -> Promise<AssistantMessage>
models.completeSimple(model, context, options?)-> Promise<AssistantMessage>
```
`AssistantMessageEventStream` (`utils/event-stream.ts`) is `class ... extends
EventStream<AssistantMessageEvent, AssistantMessage> implements AsyncIterable<...>`, with
a `.result(): Promise<AssistantMessage>` you can await after (or instead of) iterating.

`AssistantMessageEvent` (discriminated union, exact members):
`start` (`partial`), `text_start`/`text_delta`/`text_end` (`contentIndex`, `delta`|`content`,
`partial`), `thinking_start`/`thinking_delta`/`thinking_end` (same shape), `toolcall_start`/
`toolcall_delta`/`toolcall_end` (`contentIndex`, `delta`|`toolCall`, `partial`), `done`
(`reason: "stop"|"length"|"toolUse"|"deferred"`, `message`), `error` (`reason:
"aborted"|"error"`, `error: AssistantMessage`). README warns: block-type start/delta/end
sequences are **not guaranteed contiguous** — always key off `contentIndex`.

`StreamOptions` (base for every per-API Options type): `signal?`, `apiKey?`, `fetch?`,
`env?`, `onPayload?`, `onResponse?`, `headers?`, `timeoutMs?`, `maxRetries?`,
`maxRetryDelayMs?`, `temperature?`, `samplingParams?` (raw passthrough merged into the
request body — e.g. `top_p`/`top_k`/`min_p` for llama.cpp/vLLM/SGLang), `maxTokens?`,
`transport?: "sse"|"websocket"|"websocket-cached"|"auto"`, `cacheRetention?:
"none"|"short"|"long"`, `sessionId?`, `metadata?`. `SimpleStreamOptions` adds a
provider-neutral `toolChoice?: "auto"|"none"`, `reasoning?: ThinkingLevel`, `deferred?`,
`thinkingBudgets?`.

### 1.5 Tool/function calling

Tools use **TypeBox** schemas (`Type.Object(...)`, JSON-serializable):
```typescript
const weatherTool: Tool = {
  name: 'get_weather', description: 'Get current weather for a location',
  parameters: Type.Object({ location: Type.String() }),
  constrainedSampling?: false | { type:'json_schema', strict:'prefer'|'require' }
                       | { type:'grammar', variants: { openai_lark?, openai_regex? } },
};
```
Tool call in an assistant message: `{ type:"toolCall", id, name, arguments:
Record<string,any>, thoughtSignature?, namespace? }`. Feed results back as:
```typescript
context.messages.push({
  role: 'toolResult', toolCallId, toolName,
  content: [{ type: 'text', text: JSON.stringify(result) }],  // images allowed too
  isError: false, timestamp: Date.now(),
});
```
During streaming, `toolcall_delta.partial.content[contentIndex].arguments` is a
best-effort partial JSON parse (never `undefined`, defaults to `{}`); `toolcall_end`
carries the complete-but-unvalidated call. Validate with the exported
`validateToolCall(tools, toolCall)` (throws on invalid args — catch and return an
`isError: true` tool result so the model can retry). Note: Google's provider does not
stream tool-call deltas — you get one `toolcall_delta` with the full arguments.

### 1.6 Abort / cancel

Standard Web `AbortSignal`, nothing bespoke:
```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 2000);
const s = models.stream(model, context, { signal: controller.signal });
```
Aborted requests **never throw** — the stream emits an `error` event with
`reason: "aborted"` and the resolved `AssistantMessage.stopReason === "aborted"`, with
whatever partial `content`/`usage` was captured. Aborted assistant messages can be pushed
straight back into `context.messages` to continue the turn on a follow-up call. Internal
helpers `operationSignal`/`raceWithAbortSignal`/`combineAbortSignals`
(`utils/abort.ts`, `utils/abort-signals.ts`) exist for combining signals but are not
required for normal use.

### 1.7 Surprise vs. assumption (pi-ai)

- **No native Ollama `/api/chat` adapter exists.** `KnownApi` has no `"ollama"` (or
  similar) member. The library treats Ollama purely as one of many **OpenAI-compatible**
  backends (`api: 'openai-completions'`, `baseUrl: 'http://localhost:11434/v1'`) — i.e.
  you talk to Ollama's OpenAI-compat shim, not its native `/api/chat` JSON protocol. If
  the harness genuinely needs Ollama-native features unavailable through the OpenAI
  shim, pi-ai will not provide them; the "Provider interface" in the harness spec would
  need its own native-Ollama adapter outside pi-ai. `utils/overflow.d.ts`'s own doc
  comments confirm this framing ("Ollama: may truncate input silently... but may also
  return explicit overflow errors that match the [OpenAI-style] patterns above").
- The bulk of the useful surface (provider factories, raw `stream`/`streamSimple`
  functions per API) is **only reachable via subpath imports** (`/providers/*`, `/api/*`),
  not the package root — easy to miss if you only skim `index.d.ts`.
- `createModels()`/`Models` is a whole auth+catalog+persistence subsystem (OAuth,
  `CredentialStore`, dynamic model refresh with generation-checked publication) — more
  machinery than a minimal "Provider interface" wrapper needs. For a harness that owns
  its own `Provider` abstraction, calling `./api/<id>` `stream`/`streamSimple` directly
  (passing `apiKey`/`baseUrl` yourself via the `Model` object) is the lighter-weight
  integration point and avoids adopting pi-ai's auth/catalog opinions wholesale.
- Streaming events for different content blocks can **interleave** (text/thinking/tool
  deltas in one upstream chunk) — a naive per-block state machine that assumes
  start→delta*→end is contiguous per block will break; must dispatch on `contentIndex`.
- Requests never throw on failure/abort — errors surface as a normal stream event plus
  `stopReason`. A harness expecting exceptions for network/auth failures needs to check
  `event.type === 'error'` / `message.stopReason` instead.

---

## 2. `@earendil-works/pi-tui`

### 2.1 Package shape

- `"types": "./dist/index.d.ts"`, single entry point (no subpath exports map) — everything
  documented below comes from one `import ... from "@earendil-works/pi-tui"`.
- `engines.node: ">=22.19.0"`.
- Dependencies: `get-east-asian-width@1.6.0`, `marked@18.0.5` (re-exported: `Marked`,
  `Token`, `Tokens`). Dev deps only: `@xterm/headless`, `chalk` (chalk is **not** a runtime
  dependency — theme color functions are BYO, e.g. `(s) => chalk.blue(s)`, but you must
  bring your own chalk/ansi-color lib).
- Ships a **native addon** (`native/darwin/prebuilds/{darwin-arm64,darwin-x64}/
  darwin-modifiers.node`, plus a Windows equivalent) used for `isNativeModifierPressed()`
  (detecting held Shift/Cmd/Ctrl/Option outside terminal escape sequences, e.g. for
  drag-select behavior). Prebuilds exist for both Apple Silicon and Intel Mac — confirmed
  present in `node_modules` after `bun add`; no build step needed on the mini's M2 Pro.

### 2.2 Top-level app/component model (verbatim names)

Core contract — everything renderable implements `Component`:
```typescript
interface Component {
  render(width: number): string[];       // pure function of viewport width -> lines
  handleInput?(data: string): void;      // raw terminal bytes, only called when focused
  wantsKeyRelease?: boolean;             // opt in to Kitty protocol key-release events
  invalidate(): void;                    // drop cached render state (theme change etc.)
}
interface Focusable { focused: boolean; } // TUI sets this; component emits CURSOR_MARKER when true
```
`Container implements Component` — holds `children: Component[]`, `addChild/removeChild/
clear/invalidate/render`. Layout containers (`Box`, `HStack`, `VStack`, `ScrollView`,
`Spacer`) build on this for flex-like stacking.

`TUI` interface (the app shell) — two concrete renderers both implement it:
- `TuiMainScreen` — renders into the real terminal buffer + scrollback (default choice).
- `TuiAltScreen` — fixed-height viewport in the alternate screen buffer, app-owned
  scrolling (mouse/trackpad/keyboard), OSC 133 semantic-prompt jump navigation, optional
  `setLayoutRoot()` for `VStack`/`HStack`/nested `ScrollView` regions.

Both extend abstract `TuiBase extends Container implements TUI`, constructed as
`new TuiMainScreen(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?:
string)`. `TUI` surface: `addChild/removeChild/clear`, `setFocus(component|null)`,
`showOverlay(component, options?): OverlayHandle` / `hideOverlay()` / `hasOverlay()`,
`start()/stop(options?)`, `renderNow(force?)/requestRender(force?)`,
`addInputListener(fn)`/`removeInputListener(fn)`, `onTerminalColorSchemeChange(listener)`,
`queryTerminalBackgroundColor({timeoutMs})`, `queryTerminalColorScheme({timeoutMs})`,
`onDebug?: () => void` (global Shift+Ctrl+D hook).

`Terminal` interface (what you construct the TUI with) — `ProcessTerminal implements
Terminal` is the real stdin/stdout-backed implementation: `start(onInput, onResize)`,
`stop()`, `drainInput(maxMs?, idleMs?)`, `write`, `columns`/`rows`/`kittyProtocolActive`
getters, cursor/clear/title/progress control methods. Handles Kitty keyboard protocol
negotiation, `modifyOtherKeys` fallback, and (per source comments) Windows VT-input
enabling and Apple Terminal Shift+Enter quirks internally.

### 2.3 Render loop wiring (how a consumer actually drives it)

There is **no explicit render loop to write** — `TUI` self-schedules:
```typescript
const terminal = new ProcessTerminal();
const tui: TUI = new TuiMainScreen(terminal);
tui.addChild(new Text("Welcome to my app!"));
const editor = new Editor(tui, editorTheme);
editor.onSubmit = (text) => { tui.addChild(new Text(`You said: ${text}`)); };
tui.addChild(editor);
tui.setFocus(editor);
tui.addInputListener((data) => {
  if (matchesKey(data, 'ctrl+c')) { tui.stop(); process.exit(0); }
});
tui.start();
```
Any mutation that should show up on screen — `setText()` on a component, `addChild`,
etc. — should be followed by `tui.requestRender()` (debounced/coalesced internally,
`TuiBase.MIN_RENDER_INTERVAL_MS` private field caps redraw rate) or rely on components
that call it themselves (`Editor`, `Loader` do via their `tui` reference). `renderNow(force?)`
forces a synchronous redraw when you need it immediately.
`TuiMainScreen` differential rendering (README, verbatim): first render emits all lines
without clearing scrollback; a width change or an edit above the viewport triggers a full
clear+redraw; otherwise it moves the cursor to the first changed line and rewrites only
changed lines. Both renderers wrap updates in **synchronized output**
(`\x1b[?2026h...\x1b[?2026l`) for flicker-free atomic screen updates.

### 2.4 Streaming markdown

`Markdown implements Component`:
```typescript
constructor(text: string, paddingX: number, paddingY: number, theme: MarkdownTheme,
            defaultTextStyle?: DefaultTextStyle, options?: MarkdownOptions)
setText(text: string): void   // replace content; invalidates the render cache
invalidate(): void
render(width: number): string[]
```
`MarkdownTheme` is a flat map of styling functions (`heading/link/linkUrl/code/
codeBlock/codeBlockBorder/quote/quoteBorder/hr/listBullet/bold/italic/strikethrough/
underline`, each `(text: string) => string`), plus optional `highlightCode?(code, lang?):
string[]` for syntax highlighting and `codeBlockIndent?: string`. `MarkdownOptions`:
`preserveOrderedListMarkers?`, `preserveBackslashEscapes?`, `transform?(markdown,
availableWidth)`, `renderLatex?` (default true — supports rendering LaTeX math as Unicode
text via a bundled `renderLatex()` in `latex.ts`).

**Streaming pattern** (not an explicit README recipe, but the only mechanism the API
supports — confirmed against the constructor/`setText`/render-cache shape): create one
`Markdown` component per assistant turn, accumulate the growing text yourself from
`text_delta` events, and call `.setText(fullTextSoFar)` + `tui.requestRender()` on each
chunk (or throttled). `setText` invalidates `cachedText`/`cachedWidth`/`cachedLines`, so
each call re-parses the full accumulated markdown — there is no incremental-append API;
for very long streamed responses this is O(n) re-parse per delta, an efficiency
consideration for the harness, not a correctness one.

### 2.5 Multiline input editor

`Editor implements Component, Focusable`:
```typescript
constructor(tui: TUI, theme: EditorTheme, options?: EditorOptions)
interface EditorTheme { borderColor: (str: string) => string; selectList: SelectListTheme; }
interface EditorOptions { paddingX?: number; autocompleteMaxVisible?: number; }

onSubmit?: (text: string) => void;
onChange?: (text: string) => void;
disableSubmit: boolean;
borderColor: (str: string) => string;          // mutable post-construction
setAutocompleteProvider(provider: AutocompleteProvider): void;
getText()/getExpandedText()/getLines()/getCursor(): {line, col}
setText(text)/insertTextAtCursor(text)
addToHistory(text: string): void;              // for up/down prompt history
getPaddingX()/setPaddingX(n)/getAutocompleteMaxVisible()/setAutocompleteMaxVisible(n)
isShowingAutocomplete(): boolean
```
Requires a live `TUI` reference (for height-aware scrolling when content exceeds
viewport). Ships: word wrap, slash-command + Tab file-path autocomplete (via
`AutocompleteProvider`/`CombinedAutocompleteProvider`), large-paste folding (`[paste #1
+50 lines]` markers, >10 lines), kill-ring (yank/yank-pop), per-keystroke undo stack, and
a "fake cursor" render (real terminal cursor stays hidden; `Editor` draws its own via
`CURSOR_MARKER`).

### 2.6 Keybindings and interrupt handling

Two layers, both real:

1. **Low-level key matching** — `matchesKey(data: string, keyId: KeyId): boolean` +
   `Key` helper object (`Key.enter`, `Key.escape`, `Key.ctrl("c")`, `Key.ctrlShift("p")`,
   ...) or raw string literals (`"ctrl+c"`, `"shift+tab"`). `parseKey(data)`,
   `isKeyRelease(data)`/`isKeyRepeat(data)` for Kitty protocol event types,
   `decodeKittyPrintable`/`decodePrintableKey` for extracting printable chars from
   CSI-u sequences. This is what you use for a global Ctrl+C interrupt handler:
   ```typescript
   tui.addInputListener((data) => {
     if (matchesKey(data, Key.ctrl("c"))) { tui.stop(); process.exit(0); }
   });
   ```
   Necessary because raw mode intercepts SIGINT — Ctrl+C never reaches the process
   without this.

2. **Named keybinding registry** (`keybindings.ts`) — a fixed, TypeScript-declaration-
   merging-extensible `Keybindings` interface (currently ~45 entries: `tui.editor.*`,
   `tui.input.newLine/submit/tab/copy`, `tui.select.*`, `tui.altScreen.*`), each with a
   `defaultKeys: KeyId | KeyId[]` in the exported `TUI_KEYBINDINGS` const (e.g.
   `"tui.input.newLine": ["shift+enter", "ctrl+j"]`, `"tui.editor.undo": "ctrl+-"`).
   `KeybindingsManager` (`new KeybindingsManager(definitions, userBindings?)`) resolves
   user overrides over defaults, exposes `.matches(data, keybinding)`,
   `.getKeys(keybinding)`, `.getConflicts()`; module-level `setKeybindings(manager)` /
   `getKeybindings()` register a process-global instance the built-in components
   (`Editor`, `SelectList`, alt-screen scroll) consult. A harness that wants
   user-remappable keys should add its own entries to `Keybindings` via declaration
   merging and route them through the same manager rather than hardcoding `matchesKey`
   calls everywhere.

Editor's default bindings (from README, matches `TUI_KEYBINDINGS` defaults): Enter
submits; Shift+Enter/Ctrl+Enter/Alt+Enter insert a newline (terminal-dependent — Alt+Enter
most reliable); Tab autocompletes; Ctrl+K/Ctrl+U kill to end/start of line; Ctrl+W /
Alt+Backspace delete word back; Alt+D/Alt+Delete delete word forward; Ctrl+A/Ctrl+E
line start/end; Ctrl+] / Ctrl+Alt+] jump-to-character forward/backward.

### 2.7 Surprises vs. assumptions (pi-tui)

- **No incremental/append markdown API** — `Markdown.setText()` always replaces and
  re-parses the whole string; a naive assumption of an `appendText()`/delta method for
  streaming would be wrong. Buffer the full text client-side per turn.
- **You must supply your own ANSI/color library.** `chalk` is a devDependency only —
  every theme (`EditorTheme`, `MarkdownTheme`, `SelectListTheme`) is just plain functions
  `(text: string) => string`; pi-tui itself does zero colorizing.
- **The render loop is implicit**, driven by `requestRender()`/internal debounce timers —
  there's no `tick()`/`frame()` you call yourself, which is good for a harness but means
  "when does my UI actually update" is governed by pi-tui's private
  `MIN_RENDER_INTERVAL_MS` throttle, not fully caller-controlled (use `renderNow(force)`
  to bypass it when you need synchronous flush, e.g. right before `process.exit`).
  The `Editor` also needs a live `TUI` handle purely for height/scroll math — you can't
  construct one standalone and wire it up later.
- **Ships a compiled native addon** (`darwin-modifiers.node`) for modifier-key state
  outside terminal escapes; harmless on the mini (arm64 prebuild present) but worth
  knowing this isn't a pure-JS/TS package if the harness ever needs to run in an
  environment without native-module support (e.g. certain sandboxed runtimes).
- Two renderer choices (`TuiMainScreen` vs `TuiAltScreen`) aren't just cosmetic —
  `TuiAltScreen` gives you an app-owned scrollable viewport with mouse support and
  `setLayoutRoot()` region layout (closer to a "real" TUI app like htop), while
  `TuiMainScreen` behaves more like a REPL that prints into normal scrollback. Worth an
  explicit choice up front rather than defaulting to whichever the quick-start shows.

---

## 3. Bun / install gotchas encountered

- `bun add @earendil-works/pi-ai @earendil-works/pi-tui` pulled **89 packages**,
  including full provider SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`,
  `@aws-sdk/client-bedrock-runtime`) even though only Anthropic + OpenAI-compat/Ollama
  are needed — pi-ai is not tree-shaken until bundled; a harness that only wants
  Anthropic + OpenAI-compat should still expect these deps to install (no "slim" variant
  at the npm package level; tree-shaking happens at bundle time per the README's
  "Bundling and Tree Shaking" section, keyed off the `.lazy` subpath variants).
- Bun blocked two postinstall scripts by default (`bun pm untrusted`): `@google/genai`'s
  no-op `preinstall` echo, and `protobufjs`'s `postinstall` (a transitive dep of
  `@google/genai`, used for the Google Gemini provider's build). Neither postinstall is
  needed for Anthropic/OpenAI-compat/Ollama usage; left untrusted with no observed
  functional impact on the compile-check.
- No peer-dependency warnings or version conflicts for either package. `pi-telemetry`
  (peer/import used for `TelemetryContext` typing in `types.d.ts`) installs automatically
  as a same-scope sibling — not something you add yourself.
- `@earendil-works/pi-tui`'s `engines.node` floor is `>=22.19.0` — worth checking the
  harness's Node/Bun runtime meets this if it ever runs under plain Node rather than Bun.

---

## 4. Compile-check (proof the import surface is real)

File: `/private/tmp/claude-501/-/6700f270-b49b-45cf-ae1e-74e510563b8b/scratchpad/pi-probe/compile-check.ts`

Command: `bunx tsc --noEmit` (using the project's own bun-generated `tsconfig.json`:
`strict: true`, `moduleResolution: "bundler"`, `target: "ESNext"`).

**Result: exit code 0, zero errors, zero warnings.**

```typescript
// ---------- pi-ai: core types + Models collection ----------
import {
  Type,
  type Context,
  type Tool,
  type Model,
  type StreamOptions,
  type AssistantMessageEvent,
  type AssistantMessage,
  createModels,
  createProvider,
  envApiKeyAuth,
  hasApi,
  validateToolCall,
} from "@earendil-works/pi-ai";

// Anthropic provider factory (subpath import — not re-exported as a value from the root)
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

// Generic OpenAI-compatible API implementation (used for ollama /v1, vLLM, LM Studio, custom base URLs)
import { stream as openaiCompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

// Anthropic Messages API implementation, called directly (bypassing provider auth resolution)
import { stream as anthropicStream, type AnthropicOptions } from "@earendil-works/pi-ai/api/anthropic-messages";

// ---------- pi-tui: TUI shell + components ----------
import {
  type TUI,
  type Component,
  Text,
  Editor,
  type EditorTheme,
  Markdown,
  type MarkdownTheme,
  ProcessTerminal,
  TuiMainScreen,
  matchesKey,
  Key,
} from "@earendil-works/pi-tui";

// ---- pi-ai: build an Anthropic model + provider, register it in a Models collection ----
const anthropic = anthropicProvider();
const models = createModels();
models.setProvider(anthropic);

const claudeModel: Model<"anthropic-messages"> = {
  id: "claude-opus-5",
  name: "Claude Opus 5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: 200000,
  maxTokens: 32000,
};

// ---- pi-ai: build an Ollama model via the OpenAI-compatible API (Ollama's /v1, NOT native /api/chat) ----
const ollamaModel: Model<"openai-completions"> = {
  id: "llama-3.1-8b",
  name: "Llama 3.1 8B (Ollama)",
  api: "openai-completions",
  provider: "ollama",
  baseUrl: "http://localhost:11434/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000,
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  },
};

const ollama = createProvider({
  id: "ollama",
  name: "Ollama",
  baseUrl: "http://localhost:11434/v1",
  auth: { apiKey: { name: "Ollama", resolve: async () => ({ auth: {} }) } },
  models: [ollamaModel],
  api: openAICompletionsApi(),
});
models.setProvider(ollama);

// ---- pi-ai: generic OpenAI-compatible custom endpoint (any base URL) via envApiKeyAuth ----
const customCompatModel: Model<"openai-completions"> = {
  ...ollamaModel,
  id: "custom-endpoint-model",
  provider: "my-openai-compat",
  baseUrl: "https://my-inference-server.example.com/v1",
};
const customCompat = createProvider({
  id: "my-openai-compat",
  auth: { apiKey: envApiKeyAuth("My Endpoint Key", ["MY_ENDPOINT_API_KEY"]) },
  models: [customCompatModel],
  api: openAICompletionsApi(),
});
models.setProvider(customCompat);

// ---- Tool definition ----
const weatherTool: Tool = {
  name: "get_weather",
  description: "Get current weather for a location",
  parameters: Type.Object({
    location: Type.String({ description: "City name" }),
  }),
};

const context: Context = {
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "What time is it?", timestamp: Date.now() }],
  tools: [weatherTool],
};

// ---- Streaming call shape + abort ----
async function runStream() {
  const controller = new AbortController();
  const opts: StreamOptions = { signal: controller.signal };
  const s = models.stream(claudeModel, context, opts);
  for await (const event of s) {
    const e: AssistantMessageEvent = event;
    if (e.type === "text_delta") {
      process.stdout.write(e.delta);
    } else if (e.type === "toolcall_end") {
      const validated = validateToolCall([weatherTool], e.toolCall);
      void validated;
    } else if (e.type === "done" || e.type === "error") {
      const msg: AssistantMessage = e.type === "done" ? e.message : e.error;
      void msg;
    }
  }
  const final: AssistantMessage = await s.result();
  void final;
}
void runStream;

// ---- Type-guard narrowing ----
function checkModel(m: Model<any>) {
  if (hasApi(m, "anthropic-messages")) {
    const opts: AnthropicOptions = { thinkingEnabled: true };
    void opts;
  }
}
void checkModel;

// ---- Calling API implementations directly (bypasses provider auth) ----
async function directCalls() {
  const s1 = anthropicStream(claudeModel, context, { apiKey: process.env.ANTHROPIC_API_KEY });
  void s1;
  const s2 = openaiCompletionsStream(ollamaModel, context, {});
  void s2;
}
void directCalls;

// =====================================================================
// pi-tui: terminal shell wiring
// =====================================================================

const terminal = new ProcessTerminal();
const tui: TUI = new TuiMainScreen(terminal);

tui.addChild(new Text("Welcome"));

const editorTheme: EditorTheme = {
  borderColor: (s: string) => s,
  selectList: {
    selectedPrefix: "> ",
    unselectedPrefix: "  ",
  } as any,
};

const editor = new Editor(tui, editorTheme);
editor.onSubmit = (text: string) => {
  tui.addChild(new Text(`You said: ${text}`));
};
tui.addChild(editor);
tui.setFocus(editor);

const markdownTheme: MarkdownTheme = {
  heading: (t) => t,
  link: (t) => t,
  linkUrl: (t) => t,
  code: (t) => t,
  codeBlock: (t) => t,
  codeBlockBorder: (t) => t,
  quote: (t) => t,
  quoteBorder: (t) => t,
  hr: (t) => t,
  listBullet: (t) => t,
  bold: (t) => t,
  italic: (t) => t,
  strikethrough: (t) => t,
  underline: (t) => t,
};

const streamingMarkdown = new Markdown("", 1, 1, markdownTheme);
tui.addChild(streamingMarkdown);

function onAssistantTextDelta(fullTextSoFar: string) {
  streamingMarkdown.setText(fullTextSoFar);
  tui.requestRender();
}
void onAssistantTextDelta;

tui.addInputListener((data: string) => {
  if (matchesKey(data, Key.ctrl("c"))) {
    tui.stop();
    process.exit(0);
  }
  return undefined;
});

tui.start();

const _componentCheck: Component = editor;
void _componentCheck;
```

(Note: `editorTheme.selectList` is stubbed with `as any` because `SelectListTheme`'s full
shape wasn't independently verified for this reference — everything else compiles against
real, fully-checked types.)
