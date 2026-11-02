import { setTimeout as sleep } from "node:timers/promises";
import {
  McpServer,
  type CallToolResult,
  type JSONRPCMessage,
  type ServerContext,
  type StandardSchemaWithJSON,
  type Transport,
} from "@modelcontextprotocol/server";
import { WardrikError } from "./errors.ts";
import type { Http } from "./http.ts";

/** The second argument to a tool's `run`. */
export interface ToolContext {
  /** The calling agent's ID. Set by Wardrik, never by the model. */
  agent: string | undefined;
  /** The run the call is part of. */
  run: string | undefined;
  /** The same each time Wardrik runs this call. Pass it to whatever the tool changes. */
  idempotencyKey: string | undefined;
  /** Aborts when Wardrik stops waiting for the call. */
  signal: AbortSignal;
  /**
   * Reports what the call cost, in US dollars. Each report adds to the total. Budgets count it.
   * Throws a `RangeError` for a negative or non-finite amount.
   */
  cost(usd: number): void;
}

/** A tool that runs in this process, for agents to call. */
export interface ToolDefinition<Input extends StandardSchemaWithJSON = StandardSchemaWithJSON> {
  /** The tool's name. Agents see it as `workers__<name>`. */
  name: string;
  title?: string;
  /** What it does, for the model. */
  description?: string;
  /** Its arguments' schema, such as `z.object({ … })`. */
  input: Input;
  /**
   * `true` if running it again with the same idempotency key has no second effect.
   * A call cut off mid-run runs again if every worker offering the tool says so.
   * Otherwise it waits on a person.
   */
  idempotent?: boolean;
  /** `true` if it changes nothing. Other tools wait on a person unless the agent's policy allows them. */
  readOnly?: boolean;
  /** Runs the tool. Return an object or a string. Throw to fail the call. */
  run(args: StandardSchemaWithJSON.InferOutput<Input>, context: ToolContext): unknown;
}

/** Options for `work`. */
export interface WorkOptions {
  /** Stops the work and closes the socket. */
  signal?: AbortSignal | undefined;
  /** Milliseconds between pings. An unanswered ping reconnects. Defaults to `15_000`. */
  keepalive?: number | undefined;
}

const firstDelay = 500;
const lastDelay = 30_000;
const keepalive = 15_000;

/** Converts a tool's return value to MCP's `CallToolResult`. */
function answer(value: unknown): CallToolResult {
  if (value === undefined || value === null) return { content: [] };
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };

  const text = JSON.stringify(value);
  const isObject = typeof value === "object" && !Array.isArray(value);

  return {
    content: [{ type: "text", text }],
    ...(isObject ? { structuredContent: value as Record<string, unknown> } : {}),
  };
}

function failed(error: unknown): CallToolResult {
  const text = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text }] };
}

/** The tools this process offers, and the socket it offers them over. */
export class Worker {
  readonly #tools = new Map<string, ToolDefinition<any>>();
  readonly #name: string;
  readonly #version: string;
  #server: McpServer | undefined;

  constructor(name: string, version: string) {
    this.#name = name;
    this.#version = version;
  }

  /** Adds `tool`, replacing any of the same name. Offers it on an open socket too. */
  add<Input extends StandardSchemaWithJSON>(tool: ToolDefinition<Input>): void {
    const replaced = this.#tools.has(tool.name);
    this.#tools.set(tool.name, tool);

    if (this.#server && !replaced) this.#register(this.#server, tool);
  }

  /** Answers calls over a socket until `signal` aborts. Throws a `WardrikError` if the token is refused. */
  async work(http: Http, options: WorkOptions = {}): Promise<void> {
    const { signal } = options;
    const every = options.keepalive ?? keepalive;
    const url = http.url.replace(/^http/, "ws") + "/v1/workers";
    let delay = firstDelay;

    while (!signal?.aborted) {
      try {
        await this.#check(http, signal);
        const opened = Date.now();
        await this.#serve(url, http, signal, every);
        if (Date.now() - opened > lastDelay) delay = firstDelay;
      } catch (error) {
        if (error instanceof WardrikError && error.status < 500) throw error;
        if (signal?.aborted) return;
      }

      await sleep(delay, undefined, signal ? { signal } : {}).catch(() => {});
      delay = Math.min(delay * 2, lastDelay);
    }
  }

  // A WebSocket that is refused says nothing of why, so the credential is
  // tried first with a plain request, which the server answers 426 when it is good.
  async #check(http: Http, signal: AbortSignal | undefined): Promise<void> {
    await http.send("GET", "/v1/workers", { accept: [426], signal });
  }

  async #serve(url: string, http: Http, signal: AbortSignal | undefined, every: number): Promise<void> {
    const server = new McpServer({ name: this.#name, version: this.#version });
    for (const tool of this.#tools.values()) this.#register(server, tool);

    const transport = new SocketTransport(url, http.token);
    await server.connect(transport);
    this.#server = server;

    const closed = new Promise<void>((resolve) => {
      const onclose = transport.onclose;
      transport.onclose = () => {
        onclose?.();
        resolve();
      };
    });

    const stop = () => void transport.close();
    signal?.addEventListener("abort", stop, { once: true });
    const pinging = setInterval(() => ping(server, transport, every), every);

    try {
      await closed;
    } finally {
      clearInterval(pinging);
      signal?.removeEventListener("abort", stop);
      if (this.#server === server) this.#server = undefined;
    }
  }

  #register(server: McpServer, tool: ToolDefinition<any>): void {
    const annotations = {
      ...(tool.idempotent === undefined ? {} : { idempotentHint: tool.idempotent }),
      ...(tool.readOnly === undefined ? {} : { readOnlyHint: tool.readOnly }),
    };

    server.registerTool(
      tool.name,
      {
        ...(tool.title === undefined ? {} : { title: tool.title }),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.input,
        annotations,
      },
      async (args: unknown, ctx: ServerContext) => {
        const meta = ctx.mcpReq._meta ?? {};
        let costUsd: number | undefined;
        const context: ToolContext = {
          agent: typeof meta["agent"] === "string" ? meta["agent"] : undefined,
          run: typeof meta["run"] === "string" ? meta["run"] : undefined,
          idempotencyKey: typeof meta["idempotencyKey"] === "string" ? meta["idempotencyKey"] : undefined,
          signal: ctx.mcpReq.signal,
          cost(usd: number) {
            if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`A cost is US dollars, at least 0, not ${usd}`);
            costUsd = (costUsd ?? 0) + usd;
          },
        };

        let result: CallToolResult;
        try {
          result = answer(await tool.run(args, context));
        } catch (error) {
          result = failed(error);
        }
        return costUsd === undefined ? result : { ...result, _meta: { costUsd } };
      },
    );
  }
}

// Drops the socket where Wardrik doesn't answer a ping in time.
function ping(server: McpServer, transport: SocketTransport, within: number): void {
  const late = setTimeout(() => void transport.close(), within);
  server.server.ping().then(
    () => clearTimeout(late),
    () => {},
  );
}

/** MCP over one WebSocket, one JSON-RPC message to a text frame. */
class SocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  readonly #url: string;
  readonly #token: string;
  #socket: WebSocket | undefined;
  #over = false;

  constructor(url: string, token: string) {
    this.#url = url;
    this.#token = token;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.#url, {
        headers: { authorization: `Bearer ${this.#token}` },
      });
      let open = false;

      socket.onopen = () => {
        open = true;
        resolve();
      };

      socket.onerror = () => {
        const error = new Error(`The socket to ${this.#url} failed`);
        if (open) this.onerror?.(error);
        else reject(error);
      };

      socket.onclose = () => this.#ended();

      socket.onmessage = (event: MessageEvent) => {
        try {
          this.onmessage?.(JSON.parse(String(event.data)) as JSONRPCMessage);
        } catch (error) {
          this.onerror?.(error as Error);
        }
      };

      this.#socket = socket;
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.#socket?.send(JSON.stringify(message));
  }

  /** Closes the socket and ends the transport at once, since a peer that has gone may never answer. */
  async close(): Promise<void> {
    this.#socket?.close();
    this.#ended();
  }

  #ended(): void {
    if (this.#over) return;
    this.#over = true;
    this.onclose?.();
  }
}
