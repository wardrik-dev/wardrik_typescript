import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { Agent } from "./agent.ts";
import type { Handlers, ListenOptions } from "./events.ts";
import { Http } from "./http.ts";
import { Operations, type Inputs, type OperationId, type Outputs } from "./operations.ts";
import type { WardrikEvent } from "./protocol.ts";
import { Runner, type CallOptions } from "./runner.ts";
import { Worker, type ToolDefinition, type WorkOptions } from "./worker.ts";

/** This SDK's version. */
export const version = "0.0.0";

/** How `new Wardrik()` reaches the server. Each is optional. */
export interface WardrikOptions {
  /** The server. `WARDRIK_URL`, else `http://127.0.0.1:4747`, the daemon's own. */
  url?: string;
  /** A token from `wardrik token create`. `WARDRIK_TOKEN` where left out. */
  token?: string;
  /** What requests are made with; the global `fetch` where left out. */
  fetch?: typeof fetch;
  /** What this process calls itself as a tool worker. */
  name?: string;
}

const env = (name: string): string | undefined =>
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[name];

/**
 * A Wardrik server, as one token reaches it. Its namespaces, `agents`, `tokens` and the rest, are
 * the protocol's operations, and `agent(id)` an agent's.
 *
 * ```ts
 * const wardrik = new Wardrik();
 * const agent = wardrik.agent("acme/triage");
 * await agent.define({ model: "anthropic:claude-sonnet-4-5" });
 *
 * for await (const event of agent.stream("What's on fire?")) {
 *   if (event.type === "wardrik.message.delta") process.stdout.write(event.data.delta);
 * }
 * ```
 */
export class Wardrik extends Operations {
  readonly #http: Http;
  readonly #runner: Runner;
  readonly #worker: Worker;

  constructor(options: WardrikOptions = {}) {
    const token = options.token ?? env("WARDRIK_TOKEN");
    if (!token) throw new TypeError("Wardrik needs a token: pass token, or set WARDRIK_TOKEN");

    const url = options.url ?? env("WARDRIK_URL") ?? "http://127.0.0.1:4747";
    const http = new Http(url, token, options.fetch ?? globalThis.fetch);
    const runner = new Runner(http);

    super(runner);
    this.#http = http;
    this.#runner = runner;
    this.#worker = new Worker(options.name ?? "wardrik-sdk", version);
  }

  /** The agent under `id`, `org/name` or `org/@user/name`, or one of its conversations. */
  agent(id: string): Agent {
    return new Agent(this.#http, id);
  }

  /**
   * Runs the operation `id`, as `openapi.json` names it, with its path and query parameters and
   * its body as one input, and answers what it answers: what every surface runs.
   *
   *     await wardrik.run("agent.ask", { agent: "acme/triage", content: "Hi" });
   */
  run<Id extends OperationId>(id: Id, input: Inputs[Id], options: CallOptions = {}): Promise<Outputs[Id]> {
    return this.#runner.call(id, input, options);
  }

  /**
   * Follows the events of the agents `resources` covers, handing each to the handler of its type
   * with the cursor past it, and waiting for it before the next. Keep the cursor where the
   * handler keeps its work, and pass it as `after` to carry on from there: each event is handled
   * at least once, so drop a repeat by its `id`. Without `after`, it starts from what is written
   * next. A handler for `wardrik.events.dropped` hears of a log trimmed past the cursor.
   *
   *     await wardrik.listen(
   *       {
   *         "wardrik.run.completed": async (event, cursor) => {
   *           await db.transaction(async (tx) => {
   *             await tx.insertRun(event.id, event.data);
   *             await tx.saveCursor("runs", cursor);
   *           });
   *         },
   *       },
   *       { resources: ["acme/agent/*"], after: await db.cursor("runs") },
   *     );
   *
   * It resolves once `signal` aborts, and rejects with what a handler throws.
   */
  async listen(handlers: Handlers, options: ListenOptions = {}): Promise<void> {
    const input = { resources: options.resources, types: Object.keys(handlers), after: options.after };
    const events = this.#runner.stream("events.list", input, { signal: options.signal });

    for await (const event of events) {
      const handler = handlers[event.type] as ((event: WardrikEvent, cursor: string) => unknown) | undefined;
      await handler?.(event, events.cursor!);
    }
  }

  /**
   * Offers a tool that runs in this process to the agents the token reaches, once `work` is
   * called. An agent calls it as `workers__<name>` where its definition names `workers/*` among
   * its tools.
   *
   *     wardrik.tool({
   *       name: "refund_order",
   *       description: "Refund an order in full.",
   *       input: z.object({ orderId: z.string() }),
   *       idempotent: true,
   *       run: ({ orderId }, { idempotencyKey }) =>
   *         stripe.refunds.create({ payment_intent: orderId }, { idempotencyKey }),
   *     });
   *
   *     await wardrik.work();
   */
  tool<Input extends StandardSchemaWithJSON>(definition: ToolDefinition<Input>): this {
    this.#worker.add(definition);
    return this;
  }

  /** Answers calls to the tools offered with `tool`, until `signal` aborts. */
  work(options: WorkOptions = {}): Promise<void> {
    return this.#worker.work(this.#http, options);
  }
}
