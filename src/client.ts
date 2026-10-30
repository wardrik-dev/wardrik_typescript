import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { Agent } from "./agent.ts";
import type { Handlers, ListenOptions } from "./events.ts";
import { Http } from "./http.ts";
import { Operations, type Inputs, type OperationId, type Outputs } from "./operations.ts";
import type { WardrikEvent } from "./protocol.ts";
import { Runner, type CallOptions } from "./runner.ts";
import { Worker, type ToolDefinition, type WorkOptions } from "./worker.ts";

/** This SDK's version. */
export const version = "0.1.0-rc.1";

/** Options for `new Wardrik()`. Each is optional. */
export interface WardrikOptions {
  /** The server's URL. `WARDRIK_URL` unless set, else the daemon's `http://127.0.0.1:4747`. */
  url?: string;
  /** An API token, as `wardrik token create` makes. `WARDRIK_TOKEN` unless set. */
  token?: string;
  /** The `fetch` to make requests with. The global `fetch` unless set. */
  fetch?: typeof fetch;
  /** This process's name as a tool worker. `"wardrik-sdk"` unless set. */
  name?: string;
}

const env = (name: string): string | undefined =>
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[name];

/**
 * A client for one Wardrik server, using one token.
 *
 * Its namespaces, like `agents` and `tokens`, hold the protocol's operations. `agent(id)` holds
 * an agent's. Throws a `TypeError` if there's no token.
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

  /** Returns the agent `id`: `org/name`, `org/@user/name`, or a conversation of either. */
  agent(id: string): Agent {
    return new Agent(this.#http, id);
  }

  /**
   * Runs operation `id`, as `openapi.json` names it. `input` holds its path parameters, query
   * parameters and body together.
   *
   *     await wardrik.run("agent.ask", { agent: "acme/triage", content: "Hi" });
   */
  run<Id extends OperationId>(id: Id, input: Inputs[Id], options: CallOptions = {}): Promise<Outputs[Id]> {
    return this.#runner.call(id, input, options);
  }

  /**
   * Follows the events of the agents `resources` covers, and passes each to the handler for its
   * type with the cursor after it. Waits for each handler before the next event.
   *
   * Save the cursor with the handler's work, and pass it back as `after` to resume. Each event is
   * handled at least once, so drop repeats by `id`. Without `after`, it starts at the next event
   * written. A `wardrik.events.dropped` handler hears when the log was trimmed past the cursor.
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
   * Resolves when `signal` aborts. Rejects with whatever a handler throws.
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
   * Adds a tool that runs in this process. `work` offers it to the agents the token reaches.
   *
   * Agents whose tools include `workers/*` call it as `workers__<name>`.
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

  /** Answers calls to the tools added with `tool`, until `signal` aborts. */
  work(options: WorkOptions = {}): Promise<void> {
    return this.#worker.work(this.#http, options);
  }
}
