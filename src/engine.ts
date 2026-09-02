import { mkEvent, type EngineEvent, type SessionEvent } from "./events";
import type { ChatMessage, Provider } from "./provider";
import type { SessionStore } from "./session";

export class Engine {
  constructor(private opts: {
    provider: Provider; store: SessionStore; model: string; system?: string;
  }) {}

  private context(): ChatMessage[] {
    const msgs: ChatMessage[] = [];
    for (const e of this.opts.store.replay()) {
      if (e.type === "user_message") msgs.push({ role: "user", content: e.text });
      else if (e.type === "assistant_message") msgs.push({ role: "assistant", content: e.text });
    }
    return msgs;
  }

  private tryAppend(e: SessionEvent): void {
    try {
      this.opts.store.append(e);
    } catch {
      // swallow store failures
    }
  }

  async *send(text: string, o?: { signal?: AbortSignal }): AsyncIterable<EngineEvent> {
    const { store, provider, model, system } = this.opts;
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
      for await (const chunk of provider.stream({ model, system, messages: this.context(), signal: o?.signal })) {
        if (o?.signal?.aborted) {
          interrupted = true;
          break;
        }
        if (chunk.type === "delta") { acc += chunk.text; yield { type: "assistant_delta", turn, text: chunk.text }; }
        else if (chunk.type === "done") { sawDone = true; }
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
