import type { Http } from "./http.ts";
import { AgentOperations } from "./operations.ts";
import type { Ask, Interrupt, WardrikEvent } from "./protocol.ts";
import { Runner } from "./runner.ts";

/** Options for `stream` and `reply`. */
export interface StreamAskOptions {
  /** The message's ID. A retry with the same ID is queued once. Defaults to a random UUID. */
  id?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** What `reply` resolves to: the run's text, the interrupts it waits on, or how it ended. */
export type Reply =
  | { status: "completed"; message: string; run: string; text: string }
  | { status: "waiting"; message: string; run: string; interrupts: Interrupt[] }
  | { status: "failed" | "cancelled"; message: string; run: string; error: string | undefined };

const ends = new Set(["wardrik.run.completed", "wardrik.run.failed", "wardrik.run.cancelled"]);

/** The run an event belongs to: the trace id of its `traceparent`. */
const runOf = (event: WardrikEvent): string | undefined => event.traceparent.split("-")[1];

const asked = (input: string | Ask, id: string): Ask => (typeof input === "string" ? { id, content: input } : { ...input, id });

/** Options for `wardrik.agent`. */
export interface AgentOptions {
  /** A conversation's ID. It has its own history. Defaults to the agent's own history. */
  conversation?: string | undefined;
}

/**
 * An agent, or one of its conversations. Returned by `wardrik.agent`.
 *
 * - Most methods make one request, to the `agent.*` operation of the same name.
 * - `stream` and `reply` also follow the run that answers a message.
 * - Methods that can act on a conversation act on `conversation`.
 */
export class Agent extends AgentOperations {
  readonly #runner: Runner;

  /** @internal */
  constructor(http: Http, agent: string, options: AgentOptions = {}) {
    const runner = new Runner(http);
    super(runner, agent, options.conversation);
    this.#runner = runner;
  }

  /**
   * Sends a message and yields the events of the run that answers it, until the run ends.
   *
   * ```ts
   * for await (const event of agent.stream("What's on fire?")) {
   *   if (event.type === "wardrik.message.delta") process.stdout.write(event.data.delta);
   *   if (event.type === "wardrik.run.interrupted") {
   *     for (const interrupt of event.data.interrupts) await agent.approve(interrupt.id);
   *   }
   * }
   * ```
   *
   * An interrupted run carries on, on the same stream, once each interrupt is approved or denied.
   */
  async *stream(input: string | Ask, options: StreamAskOptions = {}): AsyncGenerator<WardrikEvent> {
    const id = options.id ?? (typeof input === "string" ? undefined : input.id) ?? crypto.randomUUID();
    const { cursor } = await this.ask(asked(input, id), { signal: options.signal });
    let run: string | undefined;

    const from = { agent: this.agent, conversation: this.conversation, after: cursor };

    for await (const event of this.#runner.stream("agent.events", from, options)) {
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
   * Sends a message and resolves when the run that answers it ends or waits on a person.
   *
   * ```ts
   * const reply = await agent.reply("What's on fire?");
   * if (reply.status === "completed") console.log(reply.text);
   * ```
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
