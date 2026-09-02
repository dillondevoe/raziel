import { mkEvent, type EngineEvent, type SessionEvent } from "./events";
import type { ChatMessage, Provider } from "./provider";
import type { SessionStore } from "./session";
import type { ModelProfile } from "./profiles";

type EngineOpts = { provider: Provider; store: SessionStore; system?: string }
  & ({ model: string; profile?: never } | { model?: never; profile: ModelProfile });

export class Engine {
  private provider: Provider;
  private store: SessionStore;
  private system?: string;
  private model: string;
  private sampling?: { temperature?: number; topP?: number };
  private contextTokens?: number;

  constructor(opts: EngineOpts) {
    this.provider = opts.provider;
    this.store = opts.store;
    this.system = opts.system;
    if (opts.profile) {
      this.model = opts.profile.model;
      this.sampling = opts.profile.sampling;
      this.contextTokens = opts.profile.contextTokens;
    } else {
      this.model = opts.model;
    }
  }

  private context(): ChatMessage[] {
    const msgs: ChatMessage[] = [];
    for (const e of this.store.replay()) {
      if (e.type === "user_message") msgs.push({ role: "user", content: e.text });
      else if (e.type === "assistant_message") msgs.push({ role: "assistant", content: e.text });
    }
    return msgs;
  }

  private tryAppend(e: SessionEvent): void {
    try {
      this.store.append(e);
    } catch {
      // swallow store failures
    }
  }

  async *send(text: string, o?: { signal?: AbortSignal }): AsyncIterable<EngineEvent> {
    const { store, provider, model, system, sampling, contextTokens } = this;
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

    const finish = (stop: "end" | "interrupt" | "error"): EngineEvent[] => {
      const out: EngineEvent[] = [];
      // Persist assistant_message only for "end" or "interrupt" with text
      if (stop === "end" || (stop === "interrupt" && acc.length > 0)) {
        const msg = mkEvent("assistant_message", { turn, text: acc });
        this.tryAppend(msg);
        out.push(msg);
      }
      const end = mkEvent("turn_end", { turn, stop });
      this.tryAppend(end);
      out.push(end);
      return out;
    };

    try {
      for await (const chunk of provider.stream({ model, system, messages: this.context(), signal: o?.signal, sampling, contextTokens })) {
        if (chunk.type === "done") { sawDone = true; continue; }   // a delivered done is always recorded
        if (o?.signal?.aborted) { interrupted = true; break; }
        if (chunk.type === "delta") { acc += chunk.text; yield { type: "assistant_delta", turn, text: chunk.text }; }
      }
      const stop = interrupted || (o?.signal?.aborted && !sawDone) ? "interrupt" : "end";
      yield* finish(stop);
    } catch (err) {
      const e = mkEvent("error", { turn, message: err instanceof Error ? err.message : String(err) });
      this.tryAppend(e); yield e;
      yield* finish("error");
    }
  }
}
