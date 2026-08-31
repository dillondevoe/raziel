import { mkEvent, type EngineEvent } from "./events";
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

  async *send(text: string, o?: { signal?: AbortSignal }): AsyncIterable<EngineEvent> {
    const { store, provider, model, system } = this.opts;
    const turn = `turn-${crypto.randomUUID()}`;
    const user = mkEvent("user_message", { text });
    store.append(user); yield user;

    let acc = "";
    const finish = (stop: "end" | "interrupt" | "error"): EngineEvent[] => {
      const out: EngineEvent[] = [];
      if (acc.length > 0 || stop === "end") {
        const msg = mkEvent("assistant_message", { turn, text: acc });
        store.append(msg); out.push(msg);
      }
      const end = mkEvent("turn_end", { turn, stop });
      store.append(end); out.push(end);
      return out;
    };

    try {
      for await (const chunk of provider.stream({ model, system, messages: this.context(), signal: o?.signal })) {
        if (o?.signal?.aborted) break;
        if (chunk.type === "delta") { acc += chunk.text; yield { type: "assistant_delta", turn, text: chunk.text }; }
      }
      yield* finish(o?.signal?.aborted ? "interrupt" : "end");
    } catch (err) {
      const e = mkEvent("error", { turn, message: err instanceof Error ? err.message : String(err) });
      store.append(e); yield e;
      yield* finish("error");
    }
  }
}
