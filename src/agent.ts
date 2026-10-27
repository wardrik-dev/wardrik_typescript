import type { Http } from "./http.ts";
import { AgentOperations } from "./operations.ts";
import type { Ask, Interrupt, WardrikEvent } from "./protocol.ts";
import { Runner } from "./runner.ts";

/** How `stream` and `reply` send a message. */
export interface StreamAskOptions {
  /**
   * The message's id. A message sent twice with the same id is taken once, so a retry after a lost
   * answer is safe. A new one is made where left out.
   */
  id?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** What `reply` answers: the run's text, or the calls it waits on a person for. */
export type Reply =
  | { status: "completed"; message: string; run: string; text: string }
  | { status: "waiting"; message: string; run: string; interrupts: Interrupt[] }
  | { status: "failed" | "cancelled"; message: string; run: string; error: string | undefined };

const ends = new Set(["wardrik.run.completed", "wardrik.run.failed", "wardrik.run.cancelled"]);

/** The run an event belongs to: the trace id of its `traceparent`. */
const runOf = (event: WardrikEvent): string | undefined => event.traceparent.split("-")[1];

const asked = (input: string | Ask, id: string): Ask => (typeof input === "string" ? { id, content: input } : { ...input, id });

/**
 * One agent, by its ID, `org/name` or `org/@user/name`, or one of its conversations. Its methods
 * are the protocol's `agent.*` operations, each one request, and nothing is read until one is
 * called; `stream` and `reply` follow the run that answers a message.
 */
export class Agent extends AgentOperations {
  readonly #runner: Runner;

  /** @internal */
  constructor(http: Http, agent: string) {
    const runner = new Runner(http);
    super(runner, agent);
    this.#runner = runner;
  }

  /**
   * Sends a message, and gives the events of the run that answers it, until that run completes,
   * fails or is cancelled. A run that is interrupted to wait on a person carries on once each
   * interrupt is decided, with `approve` or `deny`, and its events follow.
   *
   *     for await (const event of agent.stream("What's on fire?")) {
   *       if (event.type === "wardrik.message.delta") process.stdout.write(event.data.delta);
   *       if (event.type === "wardrik.run.interrupted") {
   *         for (const interrupt of event.data.interrupts) await agent.approve(interrupt.id);
   *       }
   *     }
   *
   * The events of other runs are left out, and so is `wardrik.agent.started`, except when the
   * agent moves to another node during this run.
   */
  async *stream(input: string | Ask, options: StreamAskOptions = {}): AsyncGenerator<WardrikEvent> {
    const id = options.id ?? (typeof input === "string" ? undefined : input.id) ?? crypto.randomUUID();
    const { cursor } = await this.ask(asked(input, id), { signal: options.signal });
    let run: string | undefined;

    for await (const event of this.#runner.stream("agent.events", { agent: this.agent, after: cursor }, options)) {
      if (event.type === "wardrik.message.created" && event.data.message.id === id) {
        yield event;
      } else if (event.type === "wardrik.run.started" && event.data.run.message_ids?.includes(id)) {
        run = event.data.run.id;
        yield event;
      } else if (run !== undefined && (runOf(event) === run || event.type === "wardrik.agent.started")) {
        yield event;
        if (ends.has(event.type)) return;
      }
    }
  }

  /**
   * Sends a message, and answers once the run that answers it ends, or waits on a person.
   *
   *     const reply = await agent.reply("What's on fire?");
   *     if (reply.status === "completed") console.log(reply.text);
   */
  async reply(input: string | Ask, options: StreamAskOptions = {}): Promise<Reply> {
    const id = options.id ?? (typeof input === "string" ? undefined : input.id) ?? crypto.randomUUID();
    let text = "";

    for await (const event of this.stream(input, { ...options, id })) {
      const run = runOf(event) ?? "";

      switch (event.type) {
        case "wardrik.message.completed":
          text = event.data.message.parts.flatMap((part) => (part.type === "text" ? [part.content ?? ""] : [])).join("");
          break;
        case "wardrik.run.interrupted":
          return { status: "waiting", message: id, run, interrupts: event.data.interrupts };
        case "wardrik.run.completed":
          return { status: "completed", message: id, run, text };
        case "wardrik.run.failed":
          return { status: "failed", message: id, run, error: event.data.error?.message };
        case "wardrik.run.cancelled":
          return { status: "cancelled", message: id, run, error: undefined };
      }
    }

    throw new Error("The stream ended before the run did.");
  }
}
