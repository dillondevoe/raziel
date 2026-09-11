import { mkEvent, type EngineEvent, type SessionEvent } from "./events";
import type { ChatMessage, Provider, TokenUsage, ToolCall, ToolResult } from "./provider";
import type { SessionStore } from "./session";
import type { ModelProfile } from "./profiles";
import { runToolTurn, type ToolDeps } from "./engine_tools";

type EngineOpts = { provider: Provider; store: SessionStore; system?: string; tools?: ToolDeps; maxRounds?: number }
  & ({ model: string; profile?: never } | { model?: never; profile: ModelProfile });

export class Engine {
  private provider: Provider;
  private store: SessionStore;
  private system?: string;
  private model: string;
  private sampling?: { temperature?: number; topP?: number };
  private contextTokens?: number;
  private tools?: ToolDeps;
  private maxRounds?: number;

  constructor(opts: EngineOpts) {
    this.provider = opts.provider;
    this.store = opts.store;
    this.system = opts.system;
    this.tools = opts.tools;
    this.maxRounds = opts.maxRounds;
    if (opts.profile) {
      this.model = opts.profile.model;
      this.sampling = opts.profile.sampling;
      this.contextTokens = opts.profile.contextTokens;
    } else {
      this.model = opts.model;
    }
  }

  /** Replays persisted events into provider-facing messages.
   *
   * The shape this produces is the whole point, so it is stated plainly: a tool
   * round replays as an ASSISTANT message carrying the round's tool calls,
   * immediately followed by ONE tool message carrying that round's results in
   * request order. Before 2026-09-10 a round replayed as a bare user message
   * reading "[tool_result read_file] ...", with no assistant turn anywhere --
   * so the model was shown a tool result for a call it could not see itself
   * having made, and did the reasonable thing: it made the call. Both live arms
   * (Claude on PR #2, astra on PR #4) then re-requested the identical read until
   * the round limit fired. The loop was never confused; it was correctly
   * responding to a transcript that lied about its own past.
   *
   * Four properties this must keep, each of which was a way to get it wrong:
   *
   * 1. Grouping is by the PERSISTED `round`, never by adjacency. Requests and
   *    results interleave per call in the log (handleToolCall emits
   *    request/approval/result for one call before starting the next), so
   *    adjacency would split a single parallel round into several.
   * 2. A request with NO round -- every session recorded before the field
   *    existed -- becomes its own round. That is the honest reading: such a log
   *    genuinely does not record whether two calls shared a round, and inventing
   *    a grouping is the fabrication this method exists to stop.
   * 3. A denied or failed call replays with `ok: false` and its output, NOT as
   *    an absence. A request whose result is missing reads to the model as
   *    unanswered, which is the same starvation in a quieter costume. Denials
   *    already carry a real tool_result ("denied by user"), so this needs no
   *    special case -- but a call that never got one (an abort mid-round) is
   *    synthesised below rather than left dangling.
   * 4. A result is paired to the NEAREST PRECEDING unanswered request with its
   *    id, never through a log-wide map. requestId is the provider's id and is
   *    only unique per response; per-response counters (call_0 every round)
   *    made a global map answer round 0 with round 1's output. A result whose
   *    request line did not survive replays as a labelled user-role recovery
   *    note -- never dropped (the evidence a side effect happened), never
   *    promoted to a call (no record says one was made).
   */
  private context(): ChatMessage[] {
    const msgs: ChatMessage[] = [];
    // Read the log ONCE. replay() re-reads and re-parses the session file on
    // every call, so two passes over `this.store.replay()` are two different
    // reads of a file the live turn is still appending to.
    const events = this.store.replay();

    // ONE pass, in log order, and pairing is by POSITION not by a global map.
    // requestId is the PROVIDER's tool-call id -- unique per response at best.
    // Several openai-compat servers and local tool parsers emit per-response
    // counters (call_0, call_1) that restart every round, so a map keyed by
    // bare requestId across the whole log was last-write-wins: round 0's call
    // answered with round 1's output, well-formed on every wire (review, Geist
    // gate 2026-09-10, two angles independently). A tool_result answers the
    // NEAREST PRECEDING request with its id that has no answer yet; the log
    // appends request-then-result per call, so that is the only correct join.
    let pending: { key: string; calls: ToolCall[]; out: (ToolResult | null)[] } | null = null;

    const flush = (): void => {
      if (!pending) return;
      msgs.push({ role: "assistant", content: "", toolCalls: pending.calls });
      msgs.push({
        role: "tool",
        results: pending.out.map((r, i) =>
          r ?? {
            // No result was ever persisted for this request -- the turn was cut
            // short between the two appends. Say that, rather than drop the
            // call: an assistant tool call with no matching result is a
            // protocol error on anthropic and a silent gap everywhere else.
            id: pending!.calls[i]!.id, name: pending!.calls[i]!.name, ok: false,
            output: "no result recorded (turn ended before the tool answered)",
          }),
      });
      pending = null;
    };

    for (const e of events) {
      if (e.type === "user_message") { flush(); msgs.push({ role: "user", content: e.text }); }
      else if (e.type === "assistant_message") { flush(); msgs.push({ role: "assistant", content: e.text }); }
      else if (e.type === "tool_request") {
        const key = e.round === undefined ? `solo:${e.requestId}` : `round:${e.turn}:${e.round}`;
        if (pending && pending.key !== key) flush();
        if (!pending) pending = { key, calls: [], out: [] };
        pending.calls.push({ id: e.requestId, name: e.tool, args: e.args });
        pending.out.push(null);
      }
      else if (e.type === "tool_result") {
        // Nearest preceding unanswered request with this id, inside the open
        // round -- results never outlive their round in the log (the next
        // round's request, or the turn's assistant_message, comes after them).
        let i = pending ? pending.calls.length - 1 : -1;
        while (i >= 0 && !(pending!.calls[i]!.id === e.requestId && pending!.out[i] === null)) i--;
        if (i >= 0) { pending!.out[i] = { id: e.requestId, name: e.tool, ok: e.ok, output: e.output }; continue; }
        // ORPHAN: the request line is gone (torn append, or rejected by
        // isValidEvent) and the result survived. It cannot be replayed as an
        // assistant call -- no record says one was made, and inventing it is
        // the fabrication this method exists to stop -- but dropping it loses
        // the evidence that a side effect already happened, after which the
        // model does it again. So it replays as a user-role note that says
        // exactly what it is. This is the ONE place a tool output rides in a
        // user message, and it is labelled as a recovery, not as a result.
        flush();
        msgs.push({ role: "user", content: `[recovered tool_result ${e.tool}; its request record was lost] ${e.output}` });
      }
    }
    flush();
    return msgs;
  }

  private tryAppend(e: SessionEvent): void {
    try {
      this.store.append(e);
    } catch {
      // Error reporting is best-effort on a failed store; normal work is not.
    }
  }

  async *send(text: string, o?: { signal?: AbortSignal }): AsyncIterable<EngineEvent> {
    const { store, provider, model, system, sampling, contextTokens, tools } = this;
    const turn = `turn-${crypto.randomUUID()}`;
    const user = mkEvent("user_message", { text });
    try {
      store.append(user);
    } catch (err) {
      const e = mkEvent("error", { turn, message: err instanceof Error ? err.message : String(err) });
      yield e;
      const end = mkEvent("turn_end", { turn, stop: "error" });
      this.tryAppend(end);
      yield end;
      return;
    }
    yield user;

    let acc = "";
    let interrupted = false;
    let sawDone = false;
    let sawUsage = false;

    const recordUsage = (usage: TokenUsage) => {
      const e = mkEvent("usage", { ...usage, turn, provider: provider.name, model });
      store.append(e);
      return e;
    };

    // Each event is yielded the moment ITS append succeeds, so a store failure on the second
    // append never hides a first that already persisted (review, PR #1: assistant_message
    // durable but never yielded, and no turn_end for the Book to flush on).
    const finish = function* (stop: "end" | "interrupt" | "error"): Generator<EngineEvent> {
      // Persist assistant_message only for "end" or "interrupt" with text
      if (stop === "end" || (stop === "interrupt" && acc.length > 0)) {
        const msg = mkEvent("assistant_message", { turn, text: acc });
        store.append(msg);
        yield msg;
      }
      const end = mkEvent("turn_end", { turn, stop });
      store.append(end);
      yield end;
    };
    // Audit records (assistant_message, turn_end, tool_request/result, approval_*) hard-fail
    // into the error boundary. Error-class events stay best-effort: a store failure must not
    // REPLACE the provider's own diagnostic with the store's (review, PR #1).
    const appendAudit = (e: SessionEvent) => { if (e.type === "error") this.tryAppend(e); else store.append(e); };

    try {
      if (tools) {
        yield* runToolTurn({
          provider, model, system, sampling, contextTokens, turn, tools,
          maxRounds: this.maxRounds,
          signal: o?.signal,
          getContext: () => this.context(),
          // A missing audit record stops the turn before further tool work.
          tryAppend: appendAudit,
          onDelta: (t) => { acc += t; },
          onUsage: recordUsage,
          finish,
        });
        return;
      }

      for await (const chunk of provider.stream({ model, system, messages: this.context(), signal: o?.signal, sampling, contextTokens })) {
        if (chunk.type === "done") { sawDone = true; continue; }   // a delivered done is always recorded
        if (o?.signal?.aborted) { interrupted = true; break; }
        if (chunk.type === "usage" && !sawUsage) { sawUsage = true; yield recordUsage(chunk.usage); }
        if (chunk.type === "delta") { acc += chunk.text; yield { type: "assistant_delta", turn, text: chunk.text }; }
      }
      const stop = interrupted || (o?.signal?.aborted && !sawDone) ? "interrupt" : "end";
      yield* finish(stop);
    } catch (err) {
      const e = mkEvent("error", { turn, message: err instanceof Error ? err.message : String(err) });
      this.tryAppend(e); yield e;
      const end = mkEvent("turn_end", { turn, stop: "error" });
      this.tryAppend(end); yield end;
    }
  }
}
