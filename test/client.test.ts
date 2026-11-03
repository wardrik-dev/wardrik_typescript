import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Wardrik, WardrikError, type WardrikEvent } from "../src/index.ts";
import { error, event, fake, json, stream, type Fake } from "./server.ts";

let server: Fake;
let wardrik: Wardrik;

const id = "agt_01JF8X5RQ2";
const path = "/v1/agents/agt_01JF8X5RQ2";
const snapshot = (cursor: string) => ({ agent: { id }, status: "idle", pending: 0, activity: null, interrupts: [], cursor });

beforeEach(async () => {
  server = await fake();
  wardrik = new Wardrik({ url: server.url, token: "wardrik_secret" });
});

afterEach(() => server.close());

const collect = async (events: AsyncIterable<WardrikEvent>, count = Infinity) => {
  const seen: WardrikEvent[] = [];
  for await (const event of events) {
    seen.push(event);
    if (seen.length >= count) break;
  }
  return seen;
};

const sent = () => server.received.map((request) => [request.method, request.path, request.body]);

describe("requests", () => {
  test("carry the token, and send an agent's ID as one encoded segment", async () => {
    server.on("GET", "/v1/agents/acme%2Ftri%3Fage", (_request, response) => json(response, 200, snapshot("c3")));

    assert.equal((await wardrik.agent("acme/tri?age").read()).cursor, "c3");
    assert.equal(server.received[0]!.headers.authorization, "Bearer wardrik_secret");
  });

  test("send a conversation's operations to its routes, with both IDs encoded", async () => {
    const conversation = "/v1/agents/a%2Fb/conversations/C1%2F1696%20.1234";
    server.on("GET", conversation, (_request, response) => json(response, 200, snapshot("c4")));
    server.on("POST", conversation + "/messages", (_request, response) => json(response, 202, { message: { id: "m1", cursor: "c5" } }));
    server.on("POST", conversation + "/interrupts/call_1/approve", (_request, response) => json(response, 200, { decisions: [] }));
    server.on("PUT", "/v1/agents/a%2Fb", (_request, response) => json(response, 200, snapshot("")));

    const thread = wardrik.agent("a/b", { conversation: "C1/1696 .1234" });
    assert.equal(thread.conversation, "C1/1696 .1234");

    assert.equal((await thread.read()).cursor, "c4");
    await thread.ask({ id: "m1", content: "hi" });
    await thread.approve("call_1");
    await thread.define({});
    await wardrik.run("agent.ask", { agent: "a/b", conversation: "C1/1696 .1234", content: "Hi" });

    assert.deepEqual(sent(), [
      ["GET", conversation, undefined],
      ["POST", conversation + "/messages", { id: "m1", content: "hi" }],
      ["POST", conversation + "/interrupts/call_1/approve", {}],
      ["PUT", "/v1/agents/a%2Fb", {}],
      ["POST", conversation + "/messages", { content: "Hi" }],
    ]);
  });

  test("refuse an empty ID, and a conversation for an operation that has none", async () => {
    await assert.rejects(wardrik.agent("").read(), TypeError);
    await assert.rejects(wardrik.agent(id, { conversation: "" }).read(), TypeError);
    await assert.rejects(wardrik.run("agent.define", { agent: id, conversation: "C1" } as never), TypeError);

    assert.deepEqual(server.received, []);
  });

  test("throw what the server answers as an error", async () => {
    server.on("GET", path, (_request, response) => json(response, 404, error("not_found", "No agent runs under agt_01JF8X5RQ2.")));

    await assert.rejects(wardrik.agent(id).read(), (thrown: unknown) => {
      assert.ok(thrown instanceof WardrikError);
      assert.equal(thrown.status, 404);
      assert.equal(thrown.type, "not_found");
      assert.equal(thrown.message, "No agent runs under agt_01JF8X5RQ2.");
      assert.equal(thrown.requestId, "req_test");
      return true;
    });
  });

  test("need a token", () => {
    const previous = process.env.WARDRIK_TOKEN;
    delete process.env.WARDRIK_TOKEN;
    assert.throws(() => new Wardrik({ url: server.url }), TypeError);

    process.env.WARDRIK_TOKEN = "wardrik_env";
    assert.doesNotThrow(() => new Wardrik({ url: server.url }));

    if (previous === undefined) delete process.env.WARDRIK_TOKEN;
    else process.env.WARDRIK_TOKEN = previous;
  });

  test("run any operation by its id, with one input", async () => {
    server.on("POST", path + "/messages", (_request, response) => json(response, 202, { message: { id: "m1", cursor: "c4" } }));

    assert.deepEqual(await wardrik.run("agent.ask", { agent: id, content: "Hi" }), { id: "m1", cursor: "c4" });
    assert.deepEqual(sent(), [["POST", path + "/messages", { content: "Hi" }]]);
  });
});

describe("an agent", () => {
  test("is defined, asked, decided, cleared and paged as the API takes it", async () => {
    server.on("PUT", path, (_request, response) => json(response, 200, snapshot("")));
    server.on("POST", path + "/messages", (_request, response) => json(response, 202, { message: { id: "m1", cursor: "c4" } }));
    server.on("PUT", path + "/triggers/sweep", (request, response) => json(response, 200, request.body));
    server.on("POST", path + "/interrupts/call_1/approve", (_request, response) =>
      json(response, 200, { decisions: [{ id: "call_1", decision: "approved" }] }),
    );
    server.on("POST", path + "/interrupts/call_2/deny", (_request, response) =>
      json(response, 200, { decisions: [{ id: "call_2", decision: "rejected" }] }),
    );
    server.on("POST", path + "/cancel", (_request, response) => json(response, 202));
    server.on("DELETE", path + "/conversation", (_request, response) => json(response, 200, snapshot("c5")));
    server.on("GET", path + "/events", (_request, response) =>
      json(response, 200, { events: [event("run.started", {}, { sequence: 5 })], next: "c5" }),
    );

    const agent = wardrik.agent(id);

    await agent.define({ model: "anthropic:claude-sonnet-4-5" });
    assert.deepEqual(await agent.ask({ id: "m1", content: "hi" }), { id: "m1", cursor: "c4" });
    await agent.triggerSet("sweep", { every: "*/30 * * * *", prompt: "Look." });
    assert.deepEqual(await agent.approve("call_1"), [{ id: "call_1", decision: "approved" }]);
    await agent.deny("call_2", { reason: "Not now." });
    assert.equal(await agent.cancel(), undefined);
    await agent.clear();
    const page = await agent.events({ after: "c4", limit: 10 });

    assert.equal(page.events[0]!.sequence, "000000000005");
    const types: WardrikEvent["type"][] = page.events.map((event) => event.type);
    assert.deepEqual(types, ["wardrik.run.started"]);
    assert.equal(page.next, "c5");
    assert.deepEqual(sent(), [
      ["PUT", path, { model: "anthropic:claude-sonnet-4-5" }],
      ["POST", path + "/messages", { id: "m1", content: "hi" }],
      ["PUT", path + "/triggers/sweep", { every: "*/30 * * * *", prompt: "Look." }],
      ["POST", path + "/interrupts/call_1/approve", {}],
      ["POST", path + "/interrupts/call_2/deny", { reason: "Not now." }],
      ["POST", path + "/cancel", undefined],
      ["DELETE", path + "/conversation", undefined],
      ["GET", path + "/events?after=c4&limit=10", undefined],
    ]);
  });

  test("is spawned, stopped and moved as the API takes it", async () => {
    const answer = { agent: { id, status: "idle", pending: 0 } };
    for (const verb of ["spawn", "stop", "move"]) server.on("POST", `${path}/${verb}`, (_request, response) => json(response, 200, answer));

    const agent = wardrik.agent(id);
    assert.deepEqual(await agent.spawn(), answer.agent);
    await agent.stop();
    await agent.move({ node: "wardrik@box2" });

    assert.deepEqual(sent(), [
      ["POST", path + "/spawn", undefined],
      ["POST", path + "/stop", undefined],
      ["POST", path + "/move", { node: "wardrik@box2" }],
    ]);
  });
});

describe("many agents", () => {
  test("are listed, cancelled, forgotten and their parked calls read", async () => {
    server.on("GET", "/v1/agents", (_request, response) => json(response, 200, { agents: [], next: null }));
    server.on("POST", "/v1/agents/cancel", (_request, response) => json(response, 202, { cancelled: ["agt_a"] }));
    server.on("DELETE", "/v1/agents", (_request, response) => json(response, 200, { forgotten: ["agt_a"], kept: [], failed: [] }));
    server.on("GET", "/v1/interrupts", (_request, response) => json(response, 200, { interrupts: [] }));

    const agents = ["agt_01JF8X5RQ2", "acme/notes"];
    assert.deepEqual(await wardrik.agents.list({ agents }), { agents: [], next: null });
    assert.deepEqual(await wardrik.agents.cancel({ agents }), ["agt_a"]);
    assert.deepEqual((await wardrik.agents.forget({ agents })).forgotten, ["agt_a"]);
    assert.deepEqual(await wardrik.interrupts.list(), []);

    const query = "agents=agt_01JF8X5RQ2&agents=acme%2Fnotes";
    assert.deepEqual(
      server.received.map((request) => [request.method, request.path]),
      [
        ["GET", "/v1/agents?" + query],
        ["POST", "/v1/agents/cancel?" + query],
        ["DELETE", "/v1/agents?" + query],
        ["GET", "/v1/interrupts"],
      ],
    );
  });
});

describe("events", () => {
  test("follow the log from where it stood, and resume after the last event that moved the cursor", async () => {
    server.on("GET", path, (_request, response) => json(response, 200, snapshot("c7")));
    server.on("GET", path + "/events", stream([event("run.started", {}, { sequence: 8 }), event("message.delta", { delta: "a" })]));
    server.on("GET", path + "/events", stream([event("run.completed", {}, { sequence: 9 })], { end: false }));

    const events = wardrik.agent(id).streamEvents();
    const seen = await collect(events, 3);

    assert.deepEqual(
      seen.map((event) => event.type),
      ["wardrik.run.started", "wardrik.message.delta", "wardrik.run.completed"],
    );

    const cursors = server.received
      .filter((request) => request.path.endsWith("/events"))
      .map((request) => request.headers["last-event-id"]);

    assert.deepEqual(cursors, ["c7", "000000000008"]);
    assert.equal(events.cursor, "000000000009");
  });

  test("end when their signal aborts", async () => {
    server.on("GET", path + "/events", stream([], { end: false }));
    const stop = new AbortController();
    const events = wardrik.agent(id).streamEvents({ after: "c0" }, { signal: stop.signal });

    const done = collect(events);
    await events.opened;
    stop.abort();

    assert.deepEqual(await done, []);
  });

  test("stop on a refusal rather than reconnect", async () => {
    server.on("GET", path + "/events", (_request, response) => json(response, 403, error("forbidden", "No.")));

    await assert.rejects(collect(wardrik.agent(id).streamEvents({ after: "c0" })), WardrikError);
    assert.equal(server.received.length, 1);
  });

  test("follow the agents named from the head of each, and resume there", async () => {
    server.on("GET", "/v1/events/head", (_request, response) => json(response, 200, { cursor: "h0" }));
    server.on("GET", "/v1/events", stream([event("run.completed", {}, { sequence: 3 })]));
    server.on("GET", "/v1/events", stream([event("run.started", {}, { sequence: 4 })], { end: false }));

    const events = wardrik.events.streamList({ agents: [id] });

    assert.deepEqual(
      (await collect(events, 2)).map((event) => event.type),
      ["wardrik.run.completed", "wardrik.run.started"],
    );

    assert.deepEqual(
      server.received.map((request) => [request.path, request.headers["last-event-id"]]),
      [
        ["/v1/events/head?agents=agt_01JF8X5RQ2", undefined],
        ["/v1/events?agents=agt_01JF8X5RQ2", "h0"],
        ["/v1/events?agents=agt_01JF8X5RQ2", "000000000003"],
      ],
    );

    assert.equal(events.cursor, "000000000004");
  });
});

describe("listen", () => {
  test("hands each event to its type's handler with the cursor past it, one after another", async () => {
    server.on("GET", "/v1/events/head", (_request, response) => json(response, 200, { cursor: "h0" }));
    server.on(
      "GET",
      "/v1/events",
      stream(
        [
          event("run.completed", { run: { id: "r1" } }, { sequence: 3 }),
          event("run.failed", { run: { id: "r2" }, error: { type: "x", message: "No." } }, { sequence: 4 }),
        ],
        { end: false },
      ),
    );

    const stop = new AbortController();
    const handled: string[] = [];
    let busy = false;

    const slow = async (name: string, cursor: string) => {
      assert.equal(busy, false);
      busy = true;
      await new Promise((resolve) => setImmediate(resolve));
      handled.push(`${name} ${cursor}`);
      busy = false;
    };

    await wardrik.listen(
      {
        "wardrik.run.completed": (event, cursor) => slow(event.data.run.id, cursor),
        "wardrik.run.failed": async (event, cursor) => {
          await slow(event.data.error.message, cursor);
          stop.abort();
        },
      },
      { agents: [id], signal: stop.signal },
    );

    assert.deepEqual(handled, ["r1 000000000003", "No. 000000000004"]);

    assert.deepEqual(
      server.received.map((request) => [request.path, request.headers["last-event-id"]]),
      [
        ["/v1/events/head?agents=agt_01JF8X5RQ2", undefined],
        ["/v1/events?agents=agt_01JF8X5RQ2&types=wardrik.run.completed&types=wardrik.run.failed", "h0"],
      ],
    );
  });

  test("carries on after the cursor given, and rejects with what a handler throws", async () => {
    server.on("GET", "/v1/events", stream([event("run.completed", { run: { id: "r1" } }, { sequence: 7 })], { end: false }));

    const listening = wardrik.listen(
      {
        "wardrik.run.completed": () => {
          throw new Error("the database is down");
        },
      },
      { agents: ["agt_01JF8X5RQ2"], after: "c6" },
    );

    await assert.rejects(listening, /the database is down/);
    assert.equal(server.received[0]!.headers["last-event-id"], "c6");
  });
});

describe("stream and reply", () => {
  const mine = "b".repeat(32);
  const theirs = "c".repeat(32);
  const text = (content: string) => ({ message: { id: "a1", role: "assistant", parts: [{ type: "text", content }] }, status: "ok", duration_ms: 1 });

  const run = [
    event("run.started", { run: { id: theirs, message_ids: ["other"] } }, { sequence: 2, run: theirs }),
    event("message.created", { message: { id: "m1", role: "user", parts: [] } }, { sequence: 3, run: theirs }),
    event("message.delta", { message: { id: "x" }, delta: "not mine" }, { run: theirs }),
    event("run.completed", { run: { id: theirs } }, { sequence: 4, run: theirs }),
    event("run.started", { run: { id: mine, message_ids: ["m1"] } }, { sequence: 5, run: mine }),
    event("run.interrupted", { run: { id: mine }, interrupts: [] }, { sequence: 6, run: mine }),
    event("agent.started", { agent: { id } }, { sequence: 7, run: "d".repeat(32) }),
    event("run.resumed", { run: { id: mine } }, { sequence: 8, run: mine }),
    event("message.delta", { message: { id: "y" }, delta: "mine" }, { run: mine }),
    event("message.completed", text("All quiet."), { sequence: 9, run: mine }),
    event("run.completed", { run: { id: mine } }, { sequence: 10, run: mine }),
    event("run.started", { run: { id: theirs, message_ids: ["later"] } }, { sequence: 11, run: theirs }),
  ];

  test("follow from where the log stood as it sent, and give only its own run's events, to its end", async () => {
    server.on("POST", path + "/messages", (_request, response) => json(response, 202, { message: { id: "m1", cursor: "c1" } }));
    server.on("GET", path + "/events", stream(run, { end: false }));

    const seen = await collect(wardrik.agent(id).stream("hi", { id: "m1" }));

    assert.deepEqual(
      server.received.map((request) => [`${request.method} ${request.path}`, request.body, request.headers["last-event-id"]]),
      [
        [`POST ${path}/messages`, { id: "m1", content: "hi" }, undefined],
        [`GET ${path}/events`, undefined, "c1"],
      ],
    );

    assert.deepEqual(
      seen.map((event) => event.type),
      [
        "wardrik.message.created",
        "wardrik.run.started",
        "wardrik.run.interrupted",
        "wardrik.agent.started",
        "wardrik.run.resumed",
        "wardrik.message.delta",
        "wardrik.message.completed",
        "wardrik.run.completed",
      ],
    );
  });

  test("answer the run's text once it ends, or what it waits on", async () => {
    const waiting = event("run.interrupted", { run: { id: mine }, interrupts: [{ id: "call_1" }] }, { sequence: 6, run: mine });
    server.on("POST", path + "/messages", (_request, response) => json(response, 202, { message: { id: "m1", cursor: "c1" } }));
    server.on("GET", path + "/events", stream(run.filter((one) => one.type !== "wardrik.run.interrupted"), { end: false }));
    server.on("POST", path + "/messages", (_request, response) => json(response, 202, { message: { id: "m1", cursor: "c1" } }));
    server.on("GET", path + "/events", stream([run[4]!, waiting], { end: false }));

    const agent = wardrik.agent(id);

    assert.deepEqual(await agent.reply("hi", { id: "m1" }), { status: "completed", message: "m1", run: mine, text: "All quiet." });
    assert.deepEqual(await agent.reply("hi", { id: "m1" }), { status: "waiting", message: "m1", run: mine, interrupts: [{ id: "call_1" }] });
  });

  test("follow a conversation's own log", async () => {
    const conversation = path + "/conversations/C1";
    server.on("POST", conversation + "/messages", (_request, response) => json(response, 202, { message: { id: "m1", cursor: "c1" } }));
    server.on("GET", conversation + "/events", stream(run, { end: false }));

    const reply = await wardrik.agent(id, { conversation: "C1" }).reply("hi", { id: "m1" });

    assert.equal(reply.status, "waiting");
    assert.deepEqual(
      server.received.map((request) => `${request.method} ${request.path}`),
      [`POST ${conversation}/messages`, `GET ${conversation}/events`],
    );
  });

  test("read nothing when the message is refused", async () => {
    server.on("POST", path + "/messages", (_request, response) => json(response, 400, error("invalid_request", "A message has text to send")));

    await assert.rejects(collect(wardrik.agent(id).stream("")), WardrikError);
    assert.deepEqual(server.received.map((request) => request.method), ["POST"]);
  });
});
