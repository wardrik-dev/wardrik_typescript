import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { Agent, type AgentOptions } from "./agent.ts";
import type { Handlers, ListenOptions } from "./events.ts";
import { Http } from "./http.ts";
import { Operations, type Inputs, type OperationId, type Outputs } from "./operations.ts";
import type { WardrikEvent } from "./protocol.ts";
import { Runner, type CallOptions } from "./runner.ts";
import { Worker, type ToolDefinition, type WorkOptions } from "./worker.ts";

/** This SDK's version. */
export const version = "0.1.0-rc.4";

/** Options for `new Wardrik()`. */
export interface WardrikOptions {
  /** The server's URL. Defaults to `WARDRIK_URL`, then `http://127.0.0.1:4747`. */
  url?: string;
  /** Sent as `Authorization: Bearer`. Defaults to `WARDRIK_TOKEN`. */
  token?: string;
  /** The `fetch` to use. Defaults to the global one. */
  fetch?: typeof fetch;
  /** This process's name as a tool worker. Defaults to `"wardrik-sdk"`. */
  name?: string;
}

const env = (name: string): string | undefined =>
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[name];

/**
 * A client for one Wardrik server.
 *
 * ```ts
 * const wardrik = new Wardrik();
 * const agent = wardrik.agent("support-bot");
 * await agent.define({ model: "anthropic:claude-sonnet-4-5" });
 *
 * for await (const event of agent.stream("What's on fire?")) {
 *   if (event.type === "wardrik.message.delta") process.stdout.write(event.data.delta);
 * }
 * ```
 *
 * Throws a `TypeError` without a token.
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

  /**
   * Returns an agent, or one of its conversations. Makes no request.
   *
   * ```ts
   * const agent = wardrik.agent("support-bot");
   * const thread = wardrik.agent("support-bot", { conversation: "C1-1696.1234" });
   * ```
   */
  agent(id: string, options: AgentOptions = {}): Agent {
    return new Agent(this.#http, id, options);
  }

  /**
   * Runs an operation by its ID, with all its parameters in `input`.
   *
   * ```ts
   * await wardrik.run("agent.ask", { agent: "support-bot", content: "Hi" });
   * ```
   */
  run<Id extends OperationId>(id: Id, input: Inputs[Id], options: CallOptions = {}): Promise<Outputs[Id]> {
    return this.#runner.call(id, input, options);
  }

  /**
   * Passes each event to the handler for its type, with the cursor after it.
   *
   * ```ts
   * await wardrik.listen(
   *   { "wardrik.run.completed": (event, cursor) => saveRun(event, cursor) },
   *   { agents: ["support-bot"], after: savedCursor },
   * );
   * ```
   *
   * - Waits for each handler before the next event.
   * - Each event arrives at least once. Drop repeats by `event.id`.
   * - Resolves when `signal` aborts. Rejects with what a handler throws.
   */
  async listen(handlers: Handlers, options: ListenOptions): Promise<void> {
    const input = { agents: options.agents, types: Object.keys(handlers), after: options.after };
    const events = this.#runner.stream("events.list", input, { signal: options.signal });

    for await (const event of events) {
      const handler = handlers[event.type] as ((event: WardrikEvent, cursor: string) => unknown) | undefined;
      await handler?.(event, events.cursor!);
    }
  }

  /**
   * Adds a tool that runs in this process. Agents whose tools include `workers/*` call it as
   * `workers__<name>`.
   *
   * ```ts
   * wardrik.tool({
   *   name: "refund_order",
   *   description: "Refund an order in full.",
   *   input: z.object({ orderId: z.string() }),
   *   idempotent: true,
   *   run: ({ orderId }, { idempotencyKey }) =>
   *     stripe.refunds.create({ payment_intent: orderId }, { idempotencyKey }),
   * });
   *
   * await wardrik.work();
   * ```
   */
  tool<Input extends StandardSchemaWithJSON>(definition: ToolDefinition<Input>): this {
    this.#worker.add(definition);
    return this;
  }

  /**
   * Answers calls to the tools added with `tool` until `signal` aborts. Reconnects on its own.
   * Throws a `WardrikError` if the token is refused.
   */
  work(options: WorkOptions = {}): Promise<void> {
    return this.#worker.work(this.#http, options);
  }
}
