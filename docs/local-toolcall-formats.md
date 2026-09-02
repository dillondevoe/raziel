---
title: Local-model tool-call wire formats — verified ground truth for M1c text parsers
purpose: >
  Evidence base for profiles.ts ParserKind additions "hermes-json" | "qwen-xml".
  These parsers are security-critical (laundering prevention: the parser may run
  ONLY over the assistant's own turn text, never over tool-result/user/quoted
  content) — every claim below is tagged with its evidence tier so the M1c
  implementer knows what's load-bearing fact vs. what still needs re-verification
  against the actual profile model before ship.
date: 2026-08-30
evidence-tiers: >
  VERIFIED-LOCAL (transcript in hand) · VERIFIED-TEMPLATE (ollama/HF template
  fetched and quoted) · SOURCED (URL, quoted) · UNVERIFIED (no evidence found —
  treat as a hypothesis, not a fact)
---

# 0. Local probe result — NEGATIVE (read this first)

**VERIFIED-LOCAL (negative result).** This machine (`/Users/dtd/jarvis-sync`,
Dillon's Mac mini) has no `ollama` binary and no local model runner of any kind:

```
$ which ollama
ollama not found
$ brew list | grep -iE "ollama|llama"        # no output
$ ls /Applications | grep -iE "lm studio|ollama"   # no output
$ brew list --cask | grep -iE "ollama|lmstudio"    # no output
```

**Consequence for this document's evidence quality:** Steps 1 (live probe, prompt
a model with/without `tools` and capture raw text) and 2 (`ollama show --template`
against an installed model) from the requested method were **not possible** on
this machine. Every claim below is therefore **SOURCED** (fetched from
HuggingFace/GitHub/ollama.com primary sources by three research passes) or
**VERIFIED-TEMPLATE** (the exact ollama Modelfile TEMPLATE text was fetched from
ollama.com's blob pages, which is the actual byte-for-byte template ollama runs —
one step short of a live probe, but not a live transcript). **Nothing here is
VERIFIED-LOCAL in the "I ran it and captured the output" sense.**

This is itself a finding for M1c: **before the qwen profile ships, someone with
an ollama install must run the live probe** (prompt `qwen3.5:9b` — the exact
model in `profiles.ts` — with a tool-inducing prompt, with and without the native
`tools` param, and diff the raw text against what's documented here). The
research below flags a specific, live, version-spanning bug (§4.3) that makes
this non-optional: ollama has a **confirmed template/format mismatch on Qwen 3.5
specifically**, which is the exact model id this harness is planned to run.

---

# 1. Hermes-style format (`hermes-json` parser)

**Evidence tier: SOURCED**, from NousResearch model cards (Hermes-2-Pro-Llama-3-8B,
Hermes-3-Llama-3.1-8B, Hermes-4-70B, Hermes-4-14B READMEs on HuggingFace), the
`NousResearch/Hermes-Function-Calling` GitHub repo, vLLM's shipped
`Hermes2ProToolParser`, and ollama's published `hermes3` Modelfile template.

## 1.1 Exact grammar

A tool call is a single `<tool_call>` … `</tool_call>` block whose body is **one
JSON object** with exactly two keys, `name` and `arguments` — `arguments` is a
**JSON object**, never a string, at the model-output layer:

```
<tool_call>
{"arguments": {"location": "Paris, France", "unit": "celsius"}, "name": "get_current_temperature"}
</tool_call><|im_end|>
```
— verbatim from `NousResearch/Hermes-2-Pro-Llama-3-8B/README.md`.

**Multiple tool calls in one turn = multiple separate `<tool_call>` blocks**, not
one block with a JSON array. This is confirmed on both ends of the pipe:
- Nous's own reference extractor (`Hermes-Function-Calling/utils.py`) wraps the
  turn in a synthetic XML root and does `root.findall(".//tool_call")` — this only
  makes sense if calls are sibling elements.
- vLLM's `Hermes2ProToolParser` regex is `re.findall(r"<tool_call>(.*?)</tool_call>|<tool_call>(.*)", re.DOTALL)` — `findall` over repeated blocks, with a second alternative to catch an **unterminated trailing block** (streaming/truncation case).

**Whitespace convention:** canonical/training form has a newline after
`<tool_call>`, the JSON compact on one line, then a newline before
`</tool_call>`. Parsers are whitespace-tolerant — both vLLM's regex (`re.DOTALL`
+ `.strip()`) and Nous's own `element.text.strip()` accept a single-line
variant with no internal newlines too. **A conforming parser must not require
the newlines** — treat them as cosmetic, not grammar.

**`<tools>` system-prompt wrapper** — tool schemas are injected as:
```
<tools> {"type": "function", "function": {"name": "get_stock_fundamentals", ...}} </tools>
```
Multiple tool defs are just concatenated inside one `<tools>…</tools>` span
(confirmed by the ollama template's `{{- range .Tools }}` loop printing each raw
tool JSON blob inline inside a single opening/closing pair).

**Tool-response side:** `<tool_response>` wraps `{"name": ..., "content": ...}`,
sent as a `tool`-role turn — **but ollama's own shipped template drops the
`name` key** and emits only `{"content": ...}` (§1.3) — a real, documented
divergence between the Nous reference format and what ollama actually renders.

**Special tokens:** `<tools>`, `</tools>`, `<tool_call>`, `</tool_call>`,
`<tool_response>`, `</tool_response>` are **added as single dedicated vocabulary
tokens** (not just literal text) starting with Hermes-2-Pro, "to assist with
agentic capabilities in parsing while streaming tokens" (Hermes-2-Pro README).
This is why vLLM forces `skip_special_tokens=False` when tools are requested —
if treated as ordinary special tokens they'd be silently stripped before any
text parser ever saw them. **This matters for Raziel**: if the local runtime
(ollama) similarly strips or mangles these as special tokens under some code
path, the raw text a Raziel parser sees may not contain the literal tag text at
all — this needs live verification (see §0).

## 1.2 Version differences (Hermes 2 Pro → 3 → 4)

- **Hermes 2 Pro** and **Hermes 3**: identical `<tool_call>`/`<tools>`/
  `<tool_response>` XML scheme, both wrapped in ChatML (`<|im_start|>role` /
  `<|im_end|>`).
- **Hermes 4**: same inner tool-call tag grammar, but adds a `<think>…</think>`
  reasoning wrapper that can precede a tool call in the same assistant turn, and
  the **outer** turn delimiter depends on the base model — Llama-3.1-based
  Hermes-4 (70B/405B) uses Llama-3 header tokens (`<|start_header_id|>` /
  `<|eot_id|>`), Qwen3-based Hermes-4 (14B) uses ChatML. **The inner
  `<tool_call>` grammar itself is unchanged across all three generations** —
  this is the stable part a parser can anchor on.

## 1.3 ollama's actual template — confirmed divergences from the Nous canonical form

**VERIFIED-TEMPLATE** — fetched from `ollama.com/library/hermes3:latest`'s blob
page (the literal Modelfile TEMPLATE ollama runs):

```gotmpl
{{- if .Tools }}<|im_start|>system
You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags. ...
{{- range .Tools }}
{{- . }}
{{- end }}</tools> Use the following pydantic model json schema for each tool call you will make: {"properties": {"arguments": {"title": "Arguments", "type": "object"}, "name": {"title": "Name", "type": "string"}}, "required": ["arguments", "name"], "title": "FunctionCall", "type": "object"} For each function call return a json object with function name and arguments within <tool_call></tool_call> XML tags as follows:
<tool_call>
{"arguments": <args-dict>, "name": <function-name>}
</tool_call><|im_end|>
{{ end }}
{{- range .Messages }}<|im_start|>{{ .Role }}
{{- if and (eq .Role "tool") .Content }}
<tool_response>
{"content": {{ .Content }}}
</tool_response>
{{- else if .Content }}
{{ .Content }}
{{- else if .ToolCalls }}
<tool_call>
{{- range .ToolCalls }}
{"name": "{{ .Function.Name }}", "arguments": {{ .Function.Arguments }}}
{{- end }}
</tool_call>
{{- end }}<|im_end|>
{{ end }}<|im_start|>assistant
```

Two divergences directly relevant to parser design:
1. **Tool-response drops `name`** — ollama emits `{"content": ...}` only, not
   Nous's `{"name": ..., "content": ...}`. Irrelevant to the *outbound* parser
   (that's what Raziel sends back, not what it parses), but a sign that ollama's
   template layer does not treat the Nous format as gospel — it edits it.
2. **Multiple `.ToolCalls` in one assistant turn are rendered inside a SINGLE
   `<tool_call>…</tool_call>` pair, one JSON object per line** — this is how
   ollama re-serializes an already-*structured* multi-tool-call response back
   into history for a follow-up turn, and it is a deviation from both the Nous
   training convention (separate blocks per call) and from what vLLM's parser
   expects. **This only fires when ollama is re-rendering `.ToolCalls` it
   already parsed out of a previous turn — it does not describe what the model
   itself emits live.** A parser reading the model's live raw-text output should
   still expect the Nous convention (separate blocks); this ollama quirk only
   matters if Raziel ever re-parses ollama's own re-serialized history text.

## 1.4 Confirmed live failure mode: raw tag text leaking into `content` unparsed

**SOURCED**, multiple independent GitHub issues, version-spanning:

- `ollama/ollama#6390` — `xe/hermes3`: reporter gets back the **literal escaped
  tokens** (`<tool_call>\n{"name": "code_interpreter"...`) in
  `message.content`, not a structured `tool_calls` array. Shown unresolved.
- `NVIDIA/NemoClaw#2731` — Hermes-3-Llama-3.1-8B via ollama's OpenAI-compat
  endpoint: "tool-calls are rendered as a stringified-JSON blob inside `content`
  as `type: text`, not as a structured `tool_calls` field," specifically under
  realistic multi-tool + complex-system-prompt shapes (a minimal single-tool test
  worked cleanly). The same model via **vLLM's `--tool-call-parser hermes`**
  parsed correctly — pinning the fault on ollama's parsing layer, not the
  model's own output format.

**This is the single strongest piece of evidence in this whole document that a
text-parser fallback is not theoretical paranoia — it is empirically the exact
failure mode ollama itself has shipped, repeatedly, across versions.**

---

# 2. Qwen-XML format (`qwen-xml` parser) — two DIFFERENT grammars, not one

**Evidence tier: SOURCED**, fetched directly from raw `tokenizer_config.json` /
`chat_template.jinja` files on HuggingFace (Qwen2, Qwen2.5-7B-Instruct,
Qwen3-8B, Qwen3-Coder-480B-A35B-Instruct) plus the Qwen3-Coder tool parser
(`qwen3coder_tool_parser.py`) shipped alongside the model, plus ollama's
published templates for `qwen2.5`, `qwen3`, `qwen3-coder`.

**Critical finding — correcting the task brief's framing:** "Qwen-XML" is not
one format. There are two structurally different grammars depending on which
Qwen generation/variant:

## 2.1 Qwen2.5 and mainline Qwen3 (e.g. Qwen3-8B) — Hermes-style JSON-in-tags, NOT XML-per-parameter

**VERIFIED-TEMPLATE**, from the raw `chat_template` field in
`Qwen/Qwen2.5-7B-Instruct/tokenizer_config.json` and `Qwen/Qwen3-8B/tokenizer_config.json`:

```
<tools>
{{tool | tojson, one per tool}}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>
```

Literal Jinja emission for a call: `\n<tool_call>\n{"name": "FUNC", "arguments": {...}}\n</tool_call>`.
Multiple calls = multiple separate `<tool_call>` blocks, same convention as
Hermes. **This is byte-for-byte the same grammar as §1** — Qwen2.5 and mainline
Qwen3 do NOT use a distinct XML-element-per-argument style. An earlier
web-summary claim (surfaced mid-research, explicitly rejected after checking the
raw file) asserted Qwen3 uses XML-per-parameter tags — **that claim is wrong**
and is called out here specifically so it doesn't get load-bearing status by
accident. Confirmed independently by `qwen.readthedocs.io/en/latest/framework/function_call.html`.

**Qwen3's only additions vs. 2.5**: `<think>...</think>` reasoning-block
handling and multi-step-tool bookkeeping — the `<tool_call>` grammar itself is
unchanged.

## 2.2 Qwen3-Coder — the real XML-per-parameter grammar

**SOURCED**, verbatim from `Qwen/Qwen3-Coder-480B-A35B-Instruct/chat_template.jinja`
and the shipped `qwen3coder_tool_parser.py` (vLLM's `Qwen3CoderToolParser` —
Qwen's own reference parser for this format):

```
<tool_call>
<function=example_function_name>
<parameter=example_parameter_1>
value_1
</parameter>
<parameter=example_parameter_2>
This is the value for the second parameter
that can span
multiple lines
</parameter>
</function>
</tool_call>
```

Grammar facts, all load-bearing for a parser:
- Outer wrapper: `<tool_call>...</tool_call>`.
- Function tag: single opening tag with **inline `=name`** — `<function=NAME>`
  — closed by a **plain `</function>`** (name NOT repeated on the close tag).
- Parameter tag: `<parameter=ARGNAME>` closed by plain `</parameter>` (name not
  repeated on close). **Arguments are not XML sub-elements with separate
  name/value structure and not attributes** — the name is inlined via `=` in
  the opening tag; the value is raw text content between open and close.
- **Multi-line strings**: literal raw text with real embedded newlines, no
  escaping, no CDATA.
- **No escaping of special characters in string values, period.** The Jinja
  template does `args_value | string` for scalars and inserts verbatim (only
  object/array values get `| tojson`). **This is a genuine injection surface**:
  if a string argument's own value contains the literal substring
  `</parameter>`, `<parameter=`, or `</function>`, the reference parser's regex
  terminates the value early there. There is no defined escape sequence to
  survive this — it is a real, acknowledged-by-construction ambiguity in the
  format itself, not a parser bug.
- Reference parser regexes (verbatim, from `qwen3coder_tool_parser.py`):
  ```python
  tool_call_regex = re.compile(r"<tool_call>(.*?)</tool_call>|<tool_call>(.*?)$", re.DOTALL)
  tool_call_function_regex = re.compile(r"<function=(.*?)</function>|<function=(.*)$", re.DOTALL)
  tool_call_parameter_regex = re.compile(
      r"<parameter=(.*?)(?:</parameter>|(?=<parameter=)|(?=</function>)|$)", re.DOTALL)
  ```
  Note the parameter regex's **lookahead-based termination** — a value ends at
  whichever comes first: its own close tag, the start of the next parameter, the
  function's close tag, or end-of-string. This is the authoritative confirmation
  that there is no escaping scheme.
- Value type coercion is **schema-dependent**: the same literal captured text
  parses differently (`int()`, `float()`, `"true"/"false"→bool` with a hardcoded
  `false` fallback if neither, or `json.loads`/`ast.literal_eval` for
  object/array types) depending on what the tool's *declared JSON-schema type*
  says for that parameter name. A schema-agnostic parser cannot fully replicate
  this without also carrying the tool schema.

**Known live reliability problem** — `github.com/QwenLM/Qwen3-Coder#475`: the
30B model frequently **omits the opening `<tool_call>` tag** (especially right
after prose), so a parser anchored strictly on that opening tag can miss
well-formed `<function=...>` blocks. No official fix confirmed in the thread.

## 2.3 Qwen2 (pre-2.5) — no baked-in format at all

**SOURCED** — `Qwen/Qwen2-7B-Instruct/tokenizer_config.json`'s chat_template has
**zero tool/tool_calls handling**. Per `qwen.readthedocs.io/en/v2.0/framework/function_call.html`,
Qwen2 tool-calling is prompt-engineered, with two competing schemes:
- an "in-house" scheme using actual **pipe-delimited special tokens**
  `<|tool_call_start|>`/`<|tool_call_end|>` wrapping `{"name":...,"arguments":...}`
  — structurally different token syntax from the plain-text `<tool_call>` tag;
- a ReAct-style scheme (Qwen-Agent framework) using `✿FUNCTION✿`/`✿ARGS✿`/
  `✿RESULT✿`/`✿RETURN✿` markers — not XML/tag-based at all.

**Do not assume Qwen2 emits `<tool_call>`** — irrelevant to `profiles.ts`'s
`qwen3.5:9b` entry, but flagged in case a future profile targets an older Qwen.

## 2.4 ollama's actual served templates — a real gap on Qwen3-Coder

**VERIFIED-TEMPLATE**, fetched directly from ollama.com blob pages:

- `qwen2.5:7b-instruct` — matches the HF template exactly (§2.1 grammar).
- `qwen3:8b` — matches HF Qwen3-8B exactly (§2.1 grammar + `<think>` handling).
- `qwen3-coder:30b` — **as currently served by ollama, this template has NO
  tool-calling support at all.** It's a bare ChatML conversation template with
  no `.Tools`, no `<tool_call>`, no `<function=...>`/`<parameter=...>`
  anywhere. This corroborates `ollama/ollama#11621` ("Qwen3-Coder missing Tools
  and FIM support in template") — shown closed on GitHub, but the live template
  fetched during this research still lacks tool support, so **whether/when a
  fix actually shipped to the official tag is UNVERIFIED**. Community GGUF
  repackagings (e.g. `unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF`) separately ship
  a corrected template with the real `<function=>`/`<parameter=>` grammar —
  meaning **the actual grammar in play from an ollama-served "Qwen3-Coder"
  depends on exactly which tag/quant was pulled**, not on the model name alone.

## 2.5 Qwen 3.5 — the exact model this harness targets, and it has a confirmed live bug

**SOURCED** — `ollama/ollama#14493`, "Qwen 3.5 27B: Tool calling completely
non-functional": root cause identified as a **template/format mismatch**.
Ollama renders Qwen 3.5 using the Qwen3 Hermes-style `<tool_call>` JSON template
(§2.1), **but Qwen 3.5 was trained on the Qwen3-Coder XML format** (§2.2).
Result: tool-call text renders inside an unclosed `<think>` block, corrupting
every subsequent turn, and generation-prompt emission breaks the agent loop.
Reported reproducing on ollama 0.17.1 through `master`.

Separately, a third-party engineering write-up (secondary source, not
independently re-verified — flagged as lower confidence) on Qwen 3.5 27B/35B
documents malformed/unclosed XML tags and format drift between native
`qwen3_xml` and Hermes-JSON shapes after long contexts (~65K+ tokens) on
distilled checkpoints, attributed to model size and checkpoint distillation, not
tool-list size.

**This directly names `profiles.ts`'s `qwen3.5:9b` entry's format as
unsettled/actively broken in at least one reported configuration.** Before this
profile ships, live-probe against the actual pulled tag is mandatory (§0) —
this is not a generic "be careful," it's a specific documented failure on this
exact model family.

---

# 3. Streaming behavior

**Evidence tier: SOURCED**, ollama docs + GitHub issues. Not tested locally (§0).

- **Native `/api/chat`, post-May-2025 refactor** (`ollama/ollama#10415`, merged
  2026-05-23 — closed #7014/#7886/#9632/#10712/ollama-python#463): moved from
  "wait for full output, then parse as one JSON blob" to an **incremental,
  prefix-based parser** that reads the model's chat-template-declared tool-call
  prefix token and matches as tokens stream in. Per the official blog
  (`ollama.com/blog/streaming-tool`): tool_calls can arrive across **multiple
  `done:false` stream chunks, not necessarily the final `done:true` chunk** —
  a client MUST accumulate `chunk.message.tool_calls` across the whole stream,
  it is not guaranteed to land in one piece.
- **Before this refactor** (pre-May-2025 ollama), streaming + tools effectively
  didn't coexist — the full output was buffered before any tool-call detection
  was attempted.
- **Still-reported problem even post-refactor**: `ollama/ollama#12557`,
  "Ollama Tool Calling + Streaming Issue" (Oct 2025): "tool calls don't stream
  progressively like text content... the two-chunk format differs from
  standard streaming APIs" — rated High severity by the reporter, workaround is
  to force `stream:false` when tools are in play.
- **OpenAI-compat `/v1/chat/completions` path is worse for streaming+tools,
  confirmed**: `ollama/ollama#9084` — enabling tools on `/v1` with
  `stream:true` causes the response to wait and return as a single complete
  block instead of progressive chunks (tools worked fine streaming-wise when
  absent, on the same endpoint). Also, `docs.ollama.com/api/openai-compatibility`
  explicitly lists `tool_choice` as **unsupported** on `/v1/chat/completions`
  (a real, documented capability gap vs. the OpenAI spec), while the newer
  `/v1/responses` endpoint claims fuller tool support.

**Practical answer to "can a delimiter appear mid-token / split across
deltas": yes, functionally** — even though ollama's own parser is
prefix-aware and tries to hold back partial matches, the *client-facing*
guarantee is only "accumulate across the stream," not "each field arrives
whole." A Raziel-side raw-text parser reading `assistant_delta` events must
buffer text across deltas and only attempt to match `<tool_call>...</tool_call>`
(or the Qwen3-Coder XML) against the **accumulated turn text**, never
per-delta — a delimiter can absolutely be split by a chunk boundary sitting
inside `<tool_c` | `all>`.

---

# 4. Ambiguity / injection surface — the security-critical question

**Evidence tier: mostly inferred from the grammar facts above (SOURCED), one
gap explicitly UNVERIFIED.**

**Can these delimiters plausibly appear in ordinary quoted text?** Yes,
trivially — `<tool_call>` and `<function=...>` are just literal text strings. A
model quoting a webpage, a code snippet, a man page, or a GitHub issue (like the
very issues cited in this doc) containing the literal substring `<tool_call>`
would produce output textually indistinguishable, at the substring level, from
an actual tool call.

**What structural signal separates the model's OWN tool call from quoted
content?**

1. **Special-token status, when the runtime preserves it — UNVERIFIED for
   ollama specifically.** Hermes's `<tool_call>` etc. are trained as dedicated
   vocabulary tokens (not decomposed into ordinary text tokens), and vLLM
   explicitly sets `skip_special_tokens=False` to keep them visible to its
   parser. **Whether ollama's `/api/chat` raw-text output preserves this
   special-token/plain-text distinction in any way a downstream consumer could
   detect (e.g. a different byte sequence, a boundary marker) — or whether by
   the time text reaches Raziel it is indistinguishable literal text regardless
   of origin — is UNVERIFIED.** This is the single most important open question
   for the security design: if ollama's output stream gives zero structural
   signal beyond byte content, then a laundering attack (get the model to quote
   attacker-controlled text containing `<tool_call>...</tool_call>` in a
   position the parser scans) is a real, live surface with no format-level
   defense — the defense would have to be positional/heuristic (e.g. only
   parse tags found outside of any fenced code block or blockquote the model
   itself used to wrap quoted material), not a property of the tag grammar
   itself.
2. **Position is not a reliable signal either.** Nous's own reference extractor
   locates "the assistant turn" via a role-boundary regex and then scans the
   *entire* turn for `<tool_call>` elements — it does not distinguish "tool
   call at the top of the turn" from "tool call embedded inside a quoted
   block later in the same turn." Same for vLLM's regex — it's a global
   `findall` over the whole completion.
3. **Confirmed empirically that structured vs. unstructured is genuinely
   ambiguous even to ollama's own server-side parser**: the §1.4 and §2.5
   failure reports are exactly this class of bug — ollama's own logic
   sometimes fails to distinguish "this is the model's real tool call" from
   "this is just text that looks like one," leaking it into `content`
   unparsed. If ollama's own first-party parser gets this wrong in
   documented, version-spanning cases, a downstream text parser inherits the
   same fundamental ambiguity and cannot assume ollama has already filtered
   out quoted/incidental matches from what lands in `message.content`.

**Practical implication for M1c's parser design** (not evidence, a design
inference labeled as such — INFERRED): since the tag text itself carries no
provable provenance once it's plain text in `message.content`, and ollama's own
server-side handling is demonstrably unreliable at this exact distinction, the
parser should be designed to run **only over text that ollama did NOT already
extract into a structured `tool_calls` field** (i.e., text-parse as a
fallback/secondary pass, never in addition to a populated `tool_calls` array —
avoid double-firing), and any laundering defense (e.g., requiring the tag to
appear at a specific position, or refusing to parse a `<tool_call>` that
appears inside what looks like a fenced quote block) is a Raziel-invented
heuristic, not something the wire format itself provides.

---

# 5. Does ollama's `/api/chat` + `tools` already return structured `tool_calls`?

**This is the most valuable finding for M1c and directly changes scope — a
genuine negative result on "is text-parsing needed at all."**

**Answer: Yes, when it works — but "when it works" is model/template/prompt-shape
dependent, not universal, and there are confirmed, still-open failure cases.**

- **VERIFIED-TEMPLATE / SOURCED**: `docs.ollama.com/api/chat` and
  `ollama/ollama/docs/api.md` document `message.tool_calls` as a real structured
  array (`[{"function": {"name": ..., "arguments": {...}}}]`) with `content`
  empty, when the model+template combination is clean.
- **Mechanism**: since PR #10415 (2026-05-23), this is implemented as a
  **generic, prefix-token-driven incremental parser** (`server/tools.go`,
  `server/model.go`) that reads whatever tool-call token/prefix each model's
  *chat template* declares — it is NOT a hardcoded list of "supported model
  families" with a guarantee of clean output. There is no per-family
  `hermes.gotmpl`/`qwen.gotmpl` parsing file in the current
  `ollama/ollama/template/` directory; the logic is centralized and
  template-driven.
- **Confirmed failure classes** (§1.4, §2.4, §2.5 above): template/model format
  mismatch (Qwen 3.5 rendered with the wrong template — a *live, currently
  reported* bug on the exact model family this harness targets), missing
  tool-support templates entirely for some served tags (Qwen3-Coder on ollama's
  official library, as currently fetched), and realistic multi-tool/complex
  system-prompt shapes causing Hermes-family raw text to leak into `content`
  even when a trivial single-tool test case works cleanly.
- **Compat-endpoint gap**: `/v1/chat/completions` has a confirmed, narrower but
  real gap — `tool_choice` unsupported per ollama's own docs, and a
  specifically-reported streaming+tools regression (#9084) where tools silently
  disable progressive streaming on that path only.

**Which families genuinely need text-parsing as a fallback, per the evidence
gathered:**
- **Hermes-family models** (hermes3 and likely hermes2-pro variants) — text
  parsing is needed as a fallback for the documented multi-tool/complex-prompt
  leak case (#6390, NemoClaw#2731), even though the simple case is handled.
- **Qwen 3.5** (the exact `profiles.ts` target) — text parsing may be
  **load-bearing, not just a fallback**, given the confirmed template
  mismatch (#14493) that can make the *structured* path actively wrong (tool
  call rendered inside a corrupted `<think>` block) rather than merely absent.
  This is the most consequential finding for M1c: the qwen profile cannot
  assume `tool_calls` will populate correctly and may need the text parser as
  primary-not-fallback until/unless the ollama-side template bug is confirmed
  fixed for the specific pulled tag.
- **Qwen3-Coder via ollama's official library tag** — text parsing is
  necessary in the strong sense: as currently served, ollama's template has NO
  tool machinery at all, so nothing will ever populate `tool_calls` — a
  consumer must either supply its own corrected template at pull time or parse
  raw text against the XML-per-parameter grammar (§2.2), and must first
  determine (empirically, per-tag) which grammar the specific served template
  actually uses (§2.4's point that community GGUF repacks differ from the
  official tag).
- **Anthropic (`sonnet` profile, `parser: "native"`)** — not in scope for this
  doc; Anthropic's API returns structured tool use natively over its own
  wire protocol, no local-model ambiguity applies.

---

# 6. maxToolSurface — tool-list-size degradation

**UNVERIFIED.** Both the Hermes and Qwen research passes searched specifically
for documentation tying tool-call format reliability or selection quality to
the *number* of tools offered, and found none from NousResearch, Qwen, ollama,
or vLLM stated in those terms. The closest adjacent findings, explicitly not
the same claim:
- Qwen3-Coder 30B FP8 omitting the opening `<tool_call>` tag (`QwenLM/Qwen3-Coder#475`) — attributed by the reporter to preceding-prose position and model size, not tool-count.
- Qwen 3.5 27B/35B format drift after long contexts (~65K+ tokens) on distilled checkpoints (secondary source, not independently verified) — attributed to context length and distillation, not tool-count.

`profiles.ts`'s comment ("qwen numbers are the landscape-scan doctrine... small
tool surface... never greedy") and its `maxToolSurface: 6` value should be
treated as **inferred/empirical house doctrine from the earlier landscape scan
referenced in SPEC.md §1** ("quality degrades past ~8 tools" — that line's own
citation is the landscape-scan subagent, not independently re-sourced here),
not as a claim this pass could independently verify. Recommend M1c benchmark
this directly (SPEC.md §5, Lane 1: "Benchmarked... not vibed") rather than
treat 6 or 8 as load-bearing constants without a local test.

---

# 7. Summary table for the parser implementer

| Format | Outer wrapper | Call body | Multi-call convention | Escaping | Confirmed live ollama gap |
|---|---|---|---|---|---|
| Hermes (2 Pro / 3 / 4) | `<tool_call>...</tool_call>` | `{"name":..,"arguments":{...}}` (JSON object args) | separate `<tool_call>` blocks | none needed (JSON handles it) | #6390, NemoClaw#2731: leaks to `content` on complex prompts |
| Qwen2.5 / Qwen3 (mainline) | `<tool_call>...</tool_call>` | identical to Hermes | separate `<tool_call>` blocks | none needed | none found for these tags specifically |
| Qwen3-Coder | `<tool_call><function=NAME>...</function></tool_call>` | per-arg `<parameter=NAME>raw_value</parameter>` | unclear/unverified for N>1 (not shown in template) | **none — real injection surface** | official ollama tag ships with NO tool template at all |
| Qwen 3.5 (profiles.ts target) | **contested** — trained on Qwen3-Coder XML, ollama renders with Qwen3 Hermes template | n/a — mismatch itself is the bug | n/a | n/a | #14493: tool-call renders inside corrupted `<think>` block |

---

# 8. Open items before M1c ships the qwen profile

1. **Live probe required (§0)** — this doc has zero VERIFIED-LOCAL transcripts.
   Install ollama, pull the exact `qwen3.5:9b` tag `profiles.ts` names, and run
   a tool-inducing prompt with and without native `tools`, capturing raw text
   verbatim, before trusting the qwen-xml parser design against real output.
2. **Confirm which grammar `qwen3.5:9b` actually emits** — §2.5 shows this is
   a live, disputed question (Hermes-JSON template applied vs. Qwen3-Coder-XML
   training) for the Qwen 3.5 family specifically. Do not assume §2.1's grammar
   applies to this exact tag without checking.
3. **Determine ollama's real special-token handling** for `<tool_call>` et al.
   on the raw-text path Raziel will actually consume (§4, point 1) — this is
   the load-bearing unknown for the laundering-prevention security property.
4. **Re-check whether `ollama/ollama#11621` and `#14493` have shipped fixes**
   by the time M1c implements — both were open/ambiguous-status as of this
   research pass (2026-08-30).
