import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { Wardrik, WardrikError } from "../src/index.ts";

// Wardrik's side of a worker's socket: the MCP client, as WardrikHTTP.Worker is.
class Peer {
  readonly socket: WebSocket;
  readonly notifications: { method: string; params: unknown }[] = [];
  /** Whether it answers the worker's pings. */
  answering = true;
  #next = 1;
  #pending = new Map<number, (message: any) => void>();
  #waiting: (() => void)[] = [];

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.method === "ping") return this.#pong(message.id);
      if ("id" in message) this.#pending.get(message.id)?.(message);
      else this.notifications.push(message);
      this.#waiting.splice(0).forEach((wake) => wake());
    });
  }

  #pong(id: number): void {
    if (this.answering) this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
  }

  /** The id of the request sent last. */
  get last(): number {
    return this.#next - 1;
  }

  request(method: string, params: object = {}): Promise<any> {
    const id = this.#next++;
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.#pending.set(id, resolve));
  }

  notify(method: string, params: object = {}): void {
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  async notified(method: string): Promise<void> {
    while (!this.notifications.some((n) => n.method === method)) {
      await new Promise<void>((wake) => this.#waiting.push(wake));
    }
  }

  async initialize(): Promise<any[]> {
    const init = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "wardrik", version: "0" },
    });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    this.notify("notifications/initialized");
    return (await this.request("tools/list")).result.tools;
  }
}

let url: string;
let peers: Peer[];
let arrived: (peer: Peer) => void;
let close: () => Promise<void>;
let stop: AbortController;

const next = () => new Promise<Peer>((resolve) => (arrived = resolve));

beforeEach(async () => {
  peers = [];
  stop = new AbortController();
  const sockets = new WebSocketServer({ noServer: true });
  const authorized = (header: string | undefined) => header === "Bearer wardrik_secret";

  const server = createServer((request, response) => {
    const status = authorized(request.headers.authorization) ? 426 : 401;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { type: status === 426 ? "upgrade_required" : "unauthorized", message: "…" } }));
  });

  server.on("upgrade", (request, socket, head) => {
    if (!authorized(request.headers.authorization)) return socket.destroy();
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const peer = new Peer(ws);
      peers.push(peer);
      arrived?.(peer);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  close = () =>
    new Promise((resolve) => {
      for (const client of sockets.clients) client.terminate();
      server.closeAllConnections();
      server.close(() => resolve());
    });
});

afterEach(async () => {
  stop.abort();
  await close();
});

test("offers its tools with their hints, and answers a call with the call's idempotency key", async () => {
  const keys: (string | undefined)[] = [];
  const wardrik = new Wardrik({ url, token: "wardrik_secret", name: "shop" });

  wardrik
    .tool({
      name: "refund_order",
      description: "Refund an order in full.",
      input: z.object({ orderId: z.string() }),
      idempotent: true,
      run: ({ orderId }, { idempotencyKey }) => {
        keys.push(idempotencyKey);
        return { refund: "re_" + orderId };
      },
    })
    .tool({
      name: "look",
      input: z.object({}),
      readOnly: true,
      run: () => "Nothing here.",
    })
    .tool({
      name: "fail",
      input: z.object({}),
      run: () => {
        throw new Error("No such order.");
      },
    });

  const arriving = next();
  const working = wardrik.work({ signal: stop.signal });
  const peer = await arriving;
  const tools = await peer.initialize();

  assert.deepEqual(
    tools.map((tool: any) => [tool.name, tool.annotations ?? {}]),
    [
      ["refund_order", { idempotentHint: true }],
      ["look", { readOnlyHint: true }],
      ["fail", {}],
    ],
  );
  assert.equal(tools[0].inputSchema.properties.orderId.type, "string");

  const refund = await peer.request("tools/call", {
    name: "refund_order",
    arguments: { orderId: "o_42" },
    _meta: { idempotencyKey: "wardrik_3f9a" },
  });

  assert.deepEqual(refund.result.structuredContent, { refund: "re_o_42" });
  assert.deepEqual(keys, ["wardrik_3f9a"]);

  const look = await peer.request("tools/call", { name: "look", arguments: {} });
  assert.deepEqual(look.result.content, [{ type: "text", text: "Nothing here." }]);

  const fail = await peer.request("tools/call", { name: "fail", arguments: {} });
  assert.equal(fail.result.isError, true);
  assert.deepEqual(fail.result.content, [{ type: "text", text: "No such order." }]);

  stop.abort();
  await working;
});

test("answers with what a call cost, where its tool says, failed or not", async () => {
  const wardrik = new Wardrik({ url, token: "wardrik_secret" });

  wardrik.tool({
    name: "lookup",
    input: z.object({ paid: z.boolean() }),
    readOnly: true,
    run: ({ paid }, { cost }) => {
      if (paid) {
        cost(0.002);
        cost(0.001);
      }
      return { found: true };
    },
  });

  wardrik.tool({
    name: "charge",
    input: z.object({}),
    run: (_args, { cost }) => {
      cost(0.25);
      throw new Error("Declined.");
    },
  });

  const arriving = next();
  const working = wardrik.work({ signal: stop.signal });
  const peer = await arriving;
  await peer.initialize();

  const paid = await peer.request("tools/call", { name: "lookup", arguments: { paid: true } });
  assert.equal(paid.result._meta.costUsd.toFixed(3), "0.003");

  const free = await peer.request("tools/call", { name: "lookup", arguments: { paid: false } });
  assert.equal(free.result._meta, undefined);

  const charged = await peer.request("tools/call", { name: "charge", arguments: {} });
  assert.equal(charged.result.isError, true);
  assert.equal(charged.result._meta.costUsd, 0.25);

  stop.abort();
  await working;
});

test("tells a tool which agent and run a call is for", async () => {
  const seen: unknown[] = [];
  const wardrik = new Wardrik({ url, token: "wardrik_secret" });

  wardrik.tool({
    name: "whose",
    input: z.object({}),
    readOnly: true,
    run: (_args, { agent, run }) => {
      seen.push({ agent, run });
      return "ok";
    },
  });

  const arriving = next();
  const working = wardrik.work({ signal: stop.signal });
  const peer = await arriving;
  await peer.initialize();

  await peer.request("tools/call", {
    name: "whose",
    arguments: {},
    _meta: {
      agent: { key: "acme/@u_42/assistant", org: "acme", user: "u_42", name: "assistant" },
      run: "4bf92f3577b34da6a3ce929d0e0e4736",
    },
  });
  await peer.request("tools/call", {
    name: "whose",
    arguments: {},
    _meta: { agent: { key: "acme/triage", org: "acme", name: "triage" } },
  });
  await peer.request("tools/call", { name: "whose", arguments: {} });

  assert.deepEqual(seen, [
    {
      agent: { key: "acme/@u_42/assistant", org: "acme", user: "u_42", name: "assistant" },
      run: "4bf92f3577b34da6a3ce929d0e0e4736",
    },
    { agent: { key: "acme/triage", org: "acme", name: "triage" }, run: undefined },
    { agent: undefined, run: undefined },
  ]);

  stop.abort();
  await working;
});

test("aborts a call Wardrik stops waiting for", async () => {
  const wardrik = new Wardrik({ url, token: "wardrik_secret" });
  let aborted!: () => void;
  const abort = new Promise<void>((resolve) => (aborted = resolve));

  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));

  wardrik.tool({
    name: "hang",
    input: z.object({}),
    run: (_args, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => (aborted(), resolve("stopped")));
        started();
      }),
  });

  const arriving = next();
  const working = wardrik.work({ signal: stop.signal });
  const peer = await arriving;
  await peer.initialize();

  void peer.request("tools/call", { name: "hang", arguments: {} });
  await running;
  peer.notify("notifications/cancelled", { requestId: peer.last, reason: "Not answered in time." });

  await abort;
  stop.abort();
  await working;
});

test("tells Wardrik when a tool is added while it works", async () => {
  const wardrik = new Wardrik({ url, token: "wardrik_secret" });
  wardrik.tool({ name: "look", input: z.object({}), run: () => "…" });

  const arriving = next();
  const working = wardrik.work({ signal: stop.signal });
  const peer = await arriving;
  await peer.initialize();

  wardrik.tool({ name: "send", input: z.object({}), run: () => "…" });
  await peer.notified("notifications/tools/list_changed");

  const tools = (await peer.request("tools/list")).result.tools;
  assert.deepEqual(tools.map((tool: any) => tool.name), ["look", "send"]);

  stop.abort();
  await working;
});

test("opens its socket again after it drops", async () => {
  const wardrik = new Wardrik({ url, token: "wardrik_secret" });
  wardrik.tool({ name: "look", input: z.object({}), run: () => "…" });

  let arriving = next();
  const working = wardrik.work({ signal: stop.signal });
  const first = await arriving;
  await first.initialize();

  arriving = next();
  first.socket.terminate();
  const second = await arriving;

  assert.deepEqual((await second.initialize()).map((tool: any) => tool.name), ["look"]);
  stop.abort();
  await working;
});

test("stops when its token is refused", async () => {
  const wardrik = new Wardrik({ url, token: "wardrik_wrong" });

  await assert.rejects(wardrik.work({ signal: stop.signal }), (thrown: unknown) => {
    assert.ok(thrown instanceof WardrikError);
    assert.equal(thrown.type, "unauthorized");
    return true;
  });
});

test("opens its socket again where Wardrik stops answering its pings, and aborts the calls it held", async () => {
  const wardrik = new Wardrik({ url, token: "wardrik_secret" });
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  let aborted!: () => void;
  const abort = new Promise<void>((resolve) => (aborted = resolve));

  wardrik.tool({
    name: "hang",
    input: z.object({}),
    run: (_args, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => (aborted(), resolve("stopped")));
        started();
      }),
  });

  let arriving = next();
  const working = wardrik.work({ signal: stop.signal, keepalive: 30 });
  const first = await arriving;
  await first.initialize();

  void first.request("tools/call", { name: "hang", arguments: {} });
  await running;

  arriving = next();
  first.answering = false;
  const second = await arriving;
  await abort;

  assert.deepEqual((await second.initialize()).map((tool: any) => tool.name), ["hang"]);
  stop.abort();
  await working;
});
