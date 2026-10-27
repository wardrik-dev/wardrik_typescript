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

/** The agent a call is made for. */
export interface CallingAgent {
  /** Its key, `org/name`, or `org/@user/name` for one that works for a user. */
  key: string;
  org: string;
  /** The user it works for, where it works for one. */
  user?: string;
  name: string;
}

/** What a tool's `run` is given beside its arguments. */
export interface ToolContext {
  /**
   * The agent the call is made for. Wardrik names it from the key this
   * worker's token was checked against, never from what the model sent, so a
   * tool serving many agents can answer each with what is theirs alone.
   */
  agent: CallingAgent | undefined;
  /** The run the call is part of: the id the run's events carry. */
  run: string | undefined;
  /**
   * The call's idempotency key, the same each time Wardrik runs this call.
   * Pass it on to what the tool changes, such as a payment API, so a call
   * run again after a crash has no second effect.
   */
  idempotencyKey: string | undefined;
  /** Aborts when Wardrik stops waiting for the call, or stops it. */
  signal: AbortSignal;
  /**
   * Says what the call cost in US dollars, such as a paid API's price for it.
   * The call's `tool_call.completed` event carries it and a budget counts it.
   * Said more than once, the amounts add up. A call that throws after saying
   * it is reported failed, at what it said.
   */
  cost(usd: number): void;
}

/** A tool that runs in this process, for agents to call. */
export interface ToolDefinition<Input extends StandardSchemaWithJSON = StandardSchemaWithJSON> {
  /** Its name. Agents see it as `workers__<name>`. */
  name: string;
  title?: string;
  /** What it does, for the model. */
  description?: string;
  /** Its arguments, as a schema such as `z.object({ … })`. */
  input: Input;
  /**
   * Whether running it again with the same idempotency key has no second
   * effect. A call Wardrik cannot tell finished, because its agent or its
   * worker was lost while the call was running, or it answered late, runs
   * again where every worker offering the tool says so, and waits for a
   * person otherwise.
   */
  idempotent?: boolean;
  /**
   * Whether it changes nothing, which makes it safe to run again as well. A
   * tool that is not read-only is gated: a call to it waits on a person
   * unless the agent's policy allows it by name.
   */
  readOnly?: boolean;
  /**
   * Does the work. An object is answered as the call's result, a string as
   * text, and a thrown error as a failed call the model is told about.
   */
  run(args: StandardSchemaWithJSON.InferOutput<Input>, context: ToolContext): unknown;
}

/** How long `work` offers this process's tools. */
export interface WorkOptions {
  /** Ends the work, closing the socket. */
  signal?: AbortSignal | undefined;
  /**
   * How many milliseconds apart the worker pings Wardrik, 15 seconds unless set. A ping not
   * answered in as long again drops the socket, which is opened again, so a server that went
   * away without closing it is not waited on.
   */
  keepalive?: number | undefined;
}

const firstDelay = 500;
const lastDelay = 30_000;
const keepalive = 15_000;

/** A result as MCP's `CallToolResult` carries it. */
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

function callingAgent(meta: unknown): CallingAgent | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;

  const { key, org, user, name } = meta as Record<string, unknown>;
  if (typeof key !== "string" || typeof org !== "string" || typeof name !== "string") return undefined;

  return typeof user === "string" ? { key, org, user, name } : { key, org, name };
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

  /** Offers `tool`, in place of any of the same name, to a socket already open too. */
  add<Input extends StandardSchemaWithJSON>(tool: ToolDefinition<Input>): void {
    const replaced = this.#tools.has(tool.name);
    this.#tools.set(tool.name, tool);

    if (this.#server && !replaced) this.#register(this.#server, tool);
  }

  /**
   * Holds a socket to the server open and answers calls over it, until
   * `signal` aborts. A dropped socket is opened again, waiting longer each
   * time up to 30 seconds. Throws a `WardrikError` when the token is refused.
   */
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

  // A WebSocket that is refused says nothing of why, so the token is tried
  // first with a plain request, which the server answers 426 when it is good.
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
          agent: callingAgent(meta["agent"]),
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

  /** Closes the socket, and ends the transport at once, as a peer that has gone may never answer. */
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
