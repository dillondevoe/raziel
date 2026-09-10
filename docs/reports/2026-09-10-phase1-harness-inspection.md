# Phase 1: Raziel harness inspection and repair

Inspected 2026-09-10. Base: `c69377f`. Working branch: `saga/phase1-harness`, already created by the launcher. Changes are uncommitted for review. I did not switch branches, commit, push, or modify main.

## 1. The four things that actually matter

**First, a green unit suite was not evidence of a usable audit agent.** I reproduced the supplied baseline, 314 passing tests, but the live probe found `ANTHROPIC_API_KEY` and `RAZIEL_COMPAT_KEY` unset in this process. The configured Ollama endpoint failed to connect. These are current launch-environment blockers, not evidence that the recently merged transports are broken. The Anthropic OAuth and API-key request tests pass. I read `git log -p -2` and separately `git show ef54d69`, because the merge in the first command did not show the profile change. No real credential was found in the searched checkout files; the credential-like test values are explicitly synthetic. I did not search another checkout, read external credential files, or put credentials in the repository.

**Second, the OpenAI-compatible path really was missing its hands.** Its stream options omitted `tools`, its request context never advertised schemas, and its mapper discarded tool-call events under an M1a comment. The engine and approval machinery already supported the required channel. I connected that existing channel and added the explicitly selected `astra-agent` profile with the seven existing builtins. The existing `astra` profile remains tool-free and retains its persona behavior. This avoids silently widening an established profile. Fixture requests now produce real file reads, approval denials, persisted results, and a second model request containing those results. This is protocol and integration verification, not a live Astra tool-use claim.

**Third, the audit could receive false assurances about evidence.** Directory searches and missing explicit paths returned successful empty results. The deliberate 200-file search limit was invisible. Separately, normal event-log append failures were swallowed: a tool could run without its request or approval being recorded, and an unsaved answer could be reported as successful. Both defects have failing-before, passing-after tests and small repairs. Search retains its bound and confinement. An event-store failure now stops the turn, surfaces an error, and prevents further tool work; error reporting itself remains best-effort if the disk is unusable.

**Fourth, the checkout is a single-session harness, not the outer delegation service.** There is no native subagent launch, join, parent-child job record, or result collector in `src/`. The only subprocess launch is the generic command builtin. This run's workspace jail, command allowlist, branch setup, and delegation machinery are not implemented by that builtin or by Raziel's CLI. I cannot repair an external launcher whose source is not present. Do not remove command-environment scrubbing to turn `run_command` into a credential-bearing agent launcher. A delegated model process needs its credential at its trusted launch boundary; its ordinary command children should still lose that credential.

### Verified capability map

`WORKS` names what I actually ran. `WORKS, fixture` does not mean an upstream model answered. `BLOCKED` is a runtime prerequisite failure. `STUBBED/DEFERRED` means advertised metadata or planned behavior lacks a working path. `ABSENT` means there is no implementation to exercise. A binary WORKS/STUBBED label would conceal the credential and external-launcher findings.

Source line references describe the repaired working tree unless marked baseline.

| Capability | Implementation | Verification and status | Consequence for phase 2 |
|---|---|---|---|
| Repository read, write, edit | `src/cli.ts:97`; `src/tools/workspace.ts:61`; `src/tools/files.ts:20`, `:63`, `:101` | **WORKS.** Existing real-file roundtrip and symlink-negative tests pass. `tests/harness-capabilities.test.ts:19` reads this checkout through the builtin. | Root is launch cwd. Supply authorized audit inputs within the chosen workspace; do not bypass confinement. |
| Repository search and enumeration | `src/tools/search.ts:35`, `:89`; `src/tools/registry.ts:11` | **WORKS after repair.** Real checkout search/glob and directory, missing-path, cap, and escape tests pass. | Search explicit subtrees. Default traversal still includes ordinary hidden/dependency directories and stops at 200 files, now with a notice. A capped result is not an exhaustive absence claim. |
| Anthropic text and native tools, API-key and OAuth routing | `src/commands.ts:20`; `src/providers/anthropic.ts:30`, `:77`, `:100`, `:134` | **WORKS, intercepted requests. BLOCKED live:** missing `ANTHROPIC_API_KEY`. Ran `tests/anthropic-oauth.test.ts` and `tests/anthropic-provider.test.ts` in the full suite, exercising actual SDK request construction and streamed parsing. | Cannot run a cloud job until the trusted launcher supplies its credential. Earlier commit prose about live success is historical evidence, not this run's result. |
| OpenAI-compatible text | `src/commands.ts:28`; `src/providers/openai_compat.ts:78`, `:100`, `:109` | **WORKS, local SSE server. BLOCKED live:** missing `RAZIEL_COMPAT_KEY`. Existing text/error/abort request tests pass. | No claim about current account entitlement or endpoint availability. |
| OpenAI-compatible native tools | `src/providers/openai_compat.ts:85`, `:103`, `:120`; `src/profiles.ts:63` | **Previously STUBBED, now WORKS with local SSE and real tools.** `tests/openai-compat-tools.test.ts:31`, `:56`, `:87`. | Use `--profile astra-agent`, not `--profile astra`, for repository work. Approvals remain in force. Live tool choice and continuation remain unverified. |
| Ollama text and forced context | `src/providers/ollama.ts:19`, `:31`, `:35` | **WORKS, injected HTTP/NDJSON. BLOCKED live:** connection failure. `tests/ollama-provider.test.ts` passes. | Cannot use the configured local model from this launch environment. This does not establish whether the model is installed elsewhere. |
| Ollama tools and parser strategy | `src/providers/ollama.ts:19`; `src/profiles.ts:1`, `:10`, `:12` | **STUBBED/DEFERRED.** No tool-schema request field or tool-call response handling; `parser` and `streamingTools` are metadata, not selected execution strategies. | Qwen is not a repository agent here even though its profile can carry six tools into the engine. The native Ollama provider drops that surface. |
| Fake model | `src/providers/fake.ts:3`; `src/cli.ts:107` | **WORKS.** Full suite and actual CLI subprocess. | Useful for transport-independent tests only. `RAZIEL_FAKE=1` is not live verification. |
| System prompt | `src/system_prompt.ts:33`; `src/cli.ts:157`; `src/commands.ts:129`; `src/tui/app.ts:126`; `src/tui/session_cmd.ts:105` | **WORKS, fixture.** Existing engine and real `/model astra` tests deliver file bytes to FakeProvider. | Missing/empty declared files warn and continue without a persona. `astra-agent` has no host-specific system file; supply the task in its input. |
| Delegation/subagents | **No implementation.** Closest primitives: `src/engine.ts:54`, `src/session.ts:35`, `src/tools/exec.ts:73`; explicit non-goal at `docs/SPEC.md:154` | **ABSENT natively; outer launcher not assessable.** Source search found no spawn-agent/join/job protocol. No delegation tool was available to this run. | Independent sessions can be launched externally, but Raziel does not dispatch, supervise, or join them. Native delegation needs a job lifecycle and capability contract, not a change to `scrubEnv`. |
| Results: events, replay, Book | `src/session.ts:44`, `:48`; `src/events.ts:5`; `src/book.ts:36`; `src/cli.ts:75`; `src/engine.ts:73`, `:109` | **WORKS locally, including repaired append failures.** Real persisted command results and a CLI-to-Book roundtrip pass in `tests/harness-capabilities.test.ts:33`, `:76`. | Collect the session log and artifact, not just prose or process exit status. No structured parent-job envelope. A failed disk can prevent even the error from being persisted. |
| Test execution through the harness | `src/tools/exec.ts:38`, `:73`, `:92`; `src/risk.ts:46`; `src/approvals.ts:82` | **WORKS.** Actual `bun test` subprocesses through Engine, computed high risk, approval, execution, replay and Book, for exit 0 and exit 1. | Commands require approval even with standing rules. The builtin has a 30-second timeout and 64,000-character result cap. It is not a child-process sandbox. |
| Test execution for this repair | `package.json:12`; `.github/workflows/ci.yml:12` | **WORKS here:** final `bun test` is 335 pass, 0 fail; `bun x tsc --noEmit` exits 0. | CI is configured for frozen-lockfile install, typecheck and tests. I did not run GitHub Actions or reinstall dependencies. |
| TUI, switching and resume | `src/tui/app.ts:75`; `src/tui/loop.ts:42`; `src/tui/session_cmd.ts:67`, `:133` | **WORKS, headless terminal fixtures.** Existing TUI, approval-cancellation, model-swap and resume tests pass. Actual plain CLI subprocess also passes. | No real-terminal usability claim. `/escalate` swaps profile explicitly; it is not a subagent or automatic rerun. |
| Usage attribution and context budgets | `src/provider.ts:5`; `src/events.ts:5`; `src/engine.ts:36`; `src/tui/status.ts:6`; `src/profiles.ts:8` | **STUBBED/DEFERRED for accounting/budget enforcement.** No usage channel/events or engine clipping/compaction. Ollama's `num_ctx` reaches the wire; compat context size is model metadata. | Logs alone cannot establish token cost, weekly-pool consumption, or reliable model attribution across swaps. Long audit sessions need bounded input slices. |

### Milestone promises versus the running tree

The v1.0 criterion is a week of real daily-driver use, not a test count: `docs/SPEC.md:137` and `docs/milestones/2026-09-05-v1.1-self-improving-loop.md:107`. Builtins, approval gating, profile swapping, resume, and the TUI have working tests. This run did not establish that the human-use bar has been passed.

The broad spec overstates the implementation. “ACP is the only door” at `docs/SPEC.md:75` is not true of code that directly constructs Engine in the CLI and TUI. No ACP endpoint or MCP client exists in `src/`. MCP, local parsers, usage display, and `/compact` have explicit later deferrals in `docs/superpowers/plans/2026-09-02-raziel-m1c-tui.md:23`, `:25`, `:144`. Session listing/resume works; fork is not implemented by `createSessionCommand`. Ctrl+C is wired; the broad spec's Esc binding is not wired by `TuiSurface`.

The v1.1 document is honest at line 3: not yet planned or built. `/scar`, `memory_write`, `memory_load`, `/memory`, and the measured two-session learning loop are absent from the event union and command routers. Its proposed capture-before-v1.0 sequence has not landed. A resumed conversation is not that self-improving loop.

## 2. The plan: implemented patches and the remaining launch gate

Four production files changed, with 70 added and 31 removed lines. No runtime dependency or Provider/event-schema change. New regression/verification files are untracked and must be included when committing. These are functional repairs, not measured token savings. Seven tool schemas can increase prompt consumption; moving a task to Astra changes which budget pays, not necessarily total consumption.

1. **Make repository search truthful.** Changed `src/tools/search.ts` to distinguish files from directories, walk an explicitly selected subtree, expose the existing 200-file limit, and return errors instead of suppressing failed file reads. Each candidate passes existing containment before reading. The original M1b plan explicitly imposed the cap and file-only explicit-path behavior; it gave no reason to report skipped evidence as a successful absence. The audit needs file:line evidence and reliable negative searches. **Verification:** `tests/search-audit.test.ts:14`, `:24`, `:32` failed before and pass after; the small-search and symlink control at line 41 passes. **Risk:** one unreadable file now fails the search rather than yielding partial success; narrow the subtree or resolve the error. **Size:** 12 added/12 removed production lines, four tests.

2. **Stop normal work on event-store failure.** Changed `src/engine.ts` so ordinary result and tool-event persistence reaches the existing error boundary, with the tool loop inside it. Best-effort writes remain on error-reporting paths. Existing tests/history explain the never-throw boundary, not claiming an unsaved success was saved or executing after a missing audit record. The audit needs collected evidence and an honest failure state. **Verification:** the pre-patch run returned successful events when assistant-message and turn-end appends failed and continued tool work after a failed request append. All six cases in `tests/engine-persistence.test.ts:39`, `:50` now pass, including no re-stream after a failed tool-result append. **Risk:** transient disk failure now stops useful work. Already executed tools cannot be undone if result persistence fails; do not automatically retry side-effectful work. **Size:** 18 added/16 removed production lines, six tests.

3. **Connect the existing compat tool channel and opt in through a separate profile.** Changed `src/providers/openai_compat.ts` to send ToolSpec schemas and convert complete structured calls to the existing StreamChunk variant. Added `astra-agent` at `src/profiles.ts:63`; updated `tests/profiles.test.ts:39`. M1a's text-only mapper explains the omission, but blocks the newly requested repository work. The audit needs reads, search, commands, and results on this provider. The pinned pi-ai implementation finalizes arguments using `parseStreamingJson` at `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:277`. Blindly accepting recovered arguments would violate existing strictness requirements. Raziel accumulates raw deltas per content index and applies strict JSON.parse at tool end. **Verification:** `tests/openai-compat-tools.test.ts` went from 1 pass/6 fail to 7 pass/0 fail: split/interleaved calls, schemas on actual HTTP requests, malformed/empty JSON refusal, abort, unchanged text-only requests, real file results and denial. The CLI accepts the new profile under a fake model. **Risk:** fixture protocol and pinned-dependency verification is not a live-endpoint test. Explicit profile selection widens tool availability, not approval authority. **Size:** 35 added/3 removed adapter lines, five profile lines, one registry-test change, seven cases.

4. **Verify local end-to-end paths, then fix credentials at the trusted launch boundary.** Added `tests/harness-capabilities.test.ts`: checkout builtins, actual passing/failing Bun subprocesses through Engine, and plain CLI-to-Book collection. Added explicitly invoked `tests/smoke-providers.ts`, excluded from `bun test`: fixed synthetic prompt, no saved credentials/replies, no upstream error bodies printed. These are verification artifacts, not additional production capabilities or before/after production fixes. The operator must supply the appropriate credential to the delegated model process outside the repository, then run `bun run tests/smoke-providers.ts sonnet astra-agent`. A successful text probe must be followed by one live approved read and result-bearing continuation. **Risk:** real probes consume the selected budget; keep credentials out of arbitrary command children. **Size:** two verification files here; external launch changes cannot be sized without their source.

### Diff review

Exact tracked diffs are available with the commands below. New files are full additions to review directly; ordinary `git diff` omits untracked files.

| Patch | Exact tracked diff | New test or verification files |
|---|---|---|
| Search | `git diff -- src/tools/search.ts` | `tests/search-audit.test.ts` |
| Persistence | `git diff -- src/engine.ts` | `tests/engine-persistence.test.ts` |
| Compat tools and agent profile | `git diff -- src/providers/openai_compat.ts src/profiles.ts tests/profiles.test.ts` | `tests/openai-compat-tools.test.ts` |
| Verification only | No additional production diff | `tests/harness-capabilities.test.ts`, `tests/smoke-providers.ts` |

Principal behavioral hunks follow for readers without a diff viewer. These are excerpts; the commands above include imports, comments and all remaining changes.

```diff
--- a/src/tools/search.ts
+++ b/src/tools/search.ts
@@
-      const files: string[] = args.path !== undefined
-        ? [ws.contain(args.path)]
-        : await walkFiles(ws.root, MAX_WALK_FILES);
+      const path = ws.contain(args.path ?? ".");
+      // One extra filename detects truncation without reading past the cap.
+      const files = (await stat(path)).isDirectory()
+        ? await walkFiles(path, MAX_WALK_FILES + 1)
+        : [path];
@@
-      for (const file of files) {
-        let text: string;
-        try {
-          text = await Bun.file(file).text();
-        } catch {
-          continue;
-        }
+      for (const file of files.slice(0, MAX_WALK_FILES)) {
+        const text = await Bun.file(ws.contain(file)).text();
@@
+      if (files.length > MAX_WALK_FILES) {
+        matches.push(`[truncated: searched ${MAX_WALK_FILES} files; narrow path]`);
+      }
```

```diff
--- a/src/engine.ts
+++ b/src/engine.ts
@@
-        this.tryAppend(msg);
+        store.append(msg);
@@
-      this.tryAppend(end);
+      store.append(end);
@@
-    if (tools) {
-      yield* runToolTurn({
-        provider, model, system, sampling, contextTokens, turn, tools,
-        signal: o?.signal,
-        getContext: () => this.context(),
-        tryAppend: (e) => this.tryAppend(e),
-        onDelta: (t) => { acc += t; },
-        finish,
-      });
-      return;
-    }
-
     try {
+      if (tools) {
+        yield* runToolTurn({
+          provider, model, system, sampling, contextTokens, turn, tools,
+          signal: o?.signal,
+          getContext: () => this.context(),
+          // A missing audit record stops the turn before further tool work.
+          tryAppend: (e) => store.append(e),
+          onDelta: (t) => { acc += t; },
+          finish,
+        });
+        return;
+      }
@@
-      yield* finish("error");
+      const end = mkEvent("turn_end", { turn, stop: "error" });
+      this.tryAppend(end); yield end;
```

```diff
--- a/src/providers/openai_compat.ts
+++ b/src/providers/openai_compat.ts
@@
+    tools?: ToolSpec[];
@@
+      tools: opts.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema as Tool["parameters"] })),
@@
+    // pi-ai finalizes arguments with a lenient streaming parser. R13/R17 require
+    // parsing the complete raw deltas strictly, not trusting recovered arguments.
+    const toolArgs = new Map<number, string>();
@@
+      if (ev.type === "toolcall_start") {
+        toolArgs.set(ev.contentIndex, "");
+        continue;
+      }
+      if (ev.type === "toolcall_delta") {
+        const raw = toolArgs.get(ev.contentIndex);
+        if (raw === undefined) throw new Error("openai-compat: tool delta without start");
+        toolArgs.set(ev.contentIndex, raw + ev.delta);
+        continue;
+      }
+      if (ev.type === "toolcall_end") {
+        const raw = toolArgs.get(ev.contentIndex);
+        toolArgs.delete(ev.contentIndex);
+        let args: unknown;
+        try {
+          if (raw === undefined) throw new Error("missing start");
+          args = JSON.parse(raw);
+        } catch {
+          throw new Error("openai-compat: invalid tool JSON");
+        }
+        const { id, name } = ev.toolCall;
+        if (!id || !name) throw new Error("openai-compat: tool call missing id or name");
+        yield { type: "tool_call", id, name, args };
+        continue;
+      }
+      if (ev.type === "done" && toolArgs.size > 0) throw new Error("openai-compat: incomplete tool call");
--- a/src/profiles.ts
+++ b/src/profiles.ts
@@
+  // Explicit agent mode preserves astra's existing tool-free persona. Uses
+  // the ordinary workspace and approval gates, with no host-specific prompt.
+  { id: "astra-agent", provider: "openai-compat", model: "gpt-6-astra",
+    baseUrl: "https://api.openai.com/v1", contextTokens: 32_768, maxToolSurface: 7,
+    parser: "native", streamingTools: true, apiKeyEnv: "RAZIEL_COMPAT_KEY" },
```

### Actual verification record

| Command/run | Result |
|---|---|
| Initial `git status`, `git log -5` | Clean branch `saga/phase1-harness`, base `c69377f` |
| Initial `bun test` | 314 pass, 0 fail, 752 assertions, 28 files |
| Initial `bun x tsc --noEmit` | Exit 0 |
| Pre-patch `bun test tests/search-audit.test.ts tests/engine-persistence.test.ts` | Exit 1. Directory evidence empty; missing-path result successful; cap notice absent; failed appends produced successful events. Returned failure output was truncated by the tool. |
| Same search/persistence command after repair | 10 pass, 0 fail, 28 assertions |
| Pre-patch `bun test tests/openai-compat-tools.test.ts` | 1 pass, 6 fail: no tool chunks, invalid JSON ignored, new profile absent |
| Same compat command after repair | 7 pass, 0 fail, 29 assertions |
| `bun run tests/smoke-providers.ts` | Exit 1: missing Anthropic key, missing compat key, Ollama connection failure |
| First `bun test tests/harness-capabilities.test.ts` and concurrent typecheck | 3 pass, 1 fail; typecheck rejected my test's `stdin.end(string)`. This was my probe bug, not a CLI defect. Corrected to `stdin.write(...)` followed by `stdin.end()`. |
| Corrected harness-capabilities run | 4 pass, 0 fail, 23 assertions; typecheck exit 0 |
| Final `bun test` | **335 pass, 0 fail, 832 assertions, 32 files** |
| Final `bun x tsc --noEmit`; `git diff --check` | Both exit 0 |

The intentionally failing child test verifies exit-1 result collection; it is not a failure in the final suite. The final total adds 21 tests. No live model returned content during this run.

## 3. What I did not change, and why

**Credential scrubbing, approvals, or confinement.** `docs/security/m1b-security-requirements.md:95` requires scrubbed command children; `src/tools/exec.ts:8` implements it. Generic commands must not inherit model credentials to accommodate a future agent launcher. The builtin confines cwd, not everything a child can access. Approval is not an OS sandbox. The outer launcher must establish the job's actual workspace and command permissions and supply credentials only to the model process. This checkout has no `--allow-write` or command-allowlist implementation to amend.

**The old Astra profile, sampling omission, and OAuth identity.** Zero-tool tests and persona swap behavior are deliberate. A separate agent profile preserves them. Omitted temperature/top_p and the dependency's max-completion-token mapping have documented reasons and passing controls. OAuth needs both auth transport and leading system identity block; deleting either repeats a diagnosed failure. The SDK owns Anthropic retries, so I added no second loop. The 429 helper wording is not a weekly-subscription meter and also applies to API-key requests; do not use it as accounting evidence.

**Qwen parsers, forced context, and sampling.** M1c explicitly defers parser work pending the local-model probe. `parser: native` does not prove tool support. I preserved the forced 32K request and non-greedy sampling rather than treating them as unexplained defaults.

**Provider/event contracts and native tool-result history.** Results are intentionally replayed as user messages beginning `[tool_result ...]`, per the M1b engine contract. I verified those bytes reach the second compat request instead of inventing native role replay. Live quality under that representation is unmeasured. No usage events, compaction, or stop-reason changes were added. Reaching the eight-round cap intentionally emits an error but finishes with `end`; an `end` event alone is not task-success evidence. Output-limit stop reasons are also not fully distinguished by the provider mappings.

**Native delegation, a queue, ACP, MCP, or memory.** The existing engine, registry, approvals, and log express the repaired single-agent file/test roundtrip. Native delegation needs things the schema cannot represent: parent/job identity, lifecycle, cancellation, join results, and explicit credential/permission inheritance. That is not a convenience flag. The launcher that created this run is the first place to verify delegation; its source was not supplied. Broader spec promises do not justify manufacturing these systems during the repair.

**Search limits, repeated fake tool scripts, and TUI safety.** The 200-file cap is deliberate; I exposed it rather than removing it. FakeProvider repeats its tool list per stream by construction in the M1b plan, not by an accidental retry loop. Input-ignore notices prevent late approval answers from being reinterpreted. Sanitization and approval cancellation have tested safety reasons. `maxToolSurface` is enforced at construction/swap sites despite its stale “carried now” comment. Conversely, `isAnchoredPath` at `src/system_prompt.ts:64` explicitly remains an unused future lint helper.

**Existing site-specific references and broad cleanup.** New code/tests add no private hostnames or operator-specific paths. The baseline already contains site-specific persona configuration/commentary at `src/profiles.ts:60`, `src/providers/anthropic.ts:33`, and in existing tests. I have not repeated those values in this report or added such defaults. Relocating the persona configuration needs a compatible replacement, not an unrelated tidy-up that breaks the recent seam. This was not a full-history secret scan or public-release sanitization pass. No dependency, lockfile, CI configuration, file name, or adjacent formatting was changed.

## 4. What I could not assess, and the evidence that would settle it

**Live access and agent behavior remain blocked.** Supply the appropriate credential to the trusted job process outside the repository and rerun the explicit probe. A fixed successful reply proves text invocation only. A live `astra-agent` session must also show an advertised read tool, approved request, actual fixture content in `tool_result`, and continuation using it. A reachable configured Ollama service would allow its live text probe. I did not infer why credentials were absent or the local service unreachable.

**Outer delegation and collection remain unverified.** Supply launcher source or an authorized in-boundary copy and one harmless job trace: chosen workspace/capabilities, credential presence without its value, job/session identifier, process outcome, collected events, and returned artifact. Verify an intentionally denied operation stays denied and an unavailable credential is named. Include cancellation/timeout evidence before claiming autonomous supervision. A credential-free `run_command` child is consistent with Raziel's security policy, but does not establish how this run itself was launched.

**Phase 2's inputs and completeness requirements were not supplied.** This run can access Raziel, not other mesh repositories or operational logs. Provide the authorized corpus inside the chosen workspace, check for secrets before model exposure, and specify whether parallel children or independent externally launched sessions are required. If auditing Raziel's own consumption, absent usage/model-attribution events require a sanctioned contract extension. If inspecting an existing usage ledger, that ledger may already supply the evidence. No savings estimate is justified without the dataset.

**Real-terminal behavior, billing, crash durability, and a completed dogfood week were not demonstrated.** Headless tests, successful appends, and OAuth-shaped requests are narrower evidence. A terminal session, provider/account usage records, crash/recovery tests, and the actual week of use would respectively settle those claims.
