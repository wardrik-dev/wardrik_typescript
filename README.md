# Wardrik SDK for TypeScript

Drives Wardrik agents over the HTTP API, and offers them tools that run in your own process.

```sh
npm install @wardrik/sdk@0.1.0-rc.2 zod
```

Runs on Node 22.18 or later, Bun or Deno. `zod` 4 is a peer dependency, used for tool inputs.

## Connecting

```ts
import { Wardrik } from "@wardrik/sdk";

const wardrik = new Wardrik();
```

Options, each optional:

* `url` - the server. `WARDRIK_URL` unless set, else `http://127.0.0.1:4747`.
* `token` - an API token. `WARDRIK_TOKEN` unless set. Throws a `TypeError` if neither is given.
* `fetch` - the `fetch` to use. The global one unless set.
* `name` - this process's name as a tool worker. `"wardrik-sdk"` unless set.

Make a token with the daemon:

```sh
wardrik token create NAME --resource 'acme/agent/*' --role reader,messenger
```

Or with `wardrik.tokens.create`, from a token that owns `*`.

A token acts for whoever made it, on the resources its patterns cover, with the roles it was made
with. A role is a named set of actions, from `reader` to `owner`.

* An action the token doesn't allow throws a `WardrikError` of type `forbidden`.
* An expired token throws one of type `unauthorized`.
* A revoked token closes its streams and workers.

## Operations

Every operation in the protocol's `openapi.json` is a generated method, so the SDK offers exactly
what the server does.

* An agent's operations are on `wardrik.agent(id)`.
* The rest are on a namespace named for the operation's prefix: `wardrik.agents.list`,
  `wardrik.tokens.create`, `wardrik.mcpServers.add`, `wardrik.ceilings.list`.
* Path parameters come first, by position. The rest of the input is one object, with the
  protocol's field names.

```ts
const agent = wardrik.agent("acme/triage");

await agent.define({
  model: "anthropic:claude-sonnet-4-5",
  instructions: "You watch the incident queue.",
  tools: ["linear/*", "workers/*"],
});

await agent.triggerSet("sweep", { every: "*/30 * * * *", prompt: "Check the queue." });
await agent.approve("call_1", { note: "Go ahead." });

const agents = await wardrik.agents.list({ resources: ["acme/agent/*"] });
const linear = await wardrik.connections.connect("linear", { owner: "acme/@jon" });
```

An output with one property resolves to that property: `agents.list` resolves to the list,
`agent.ask` to the message. An operation with no output resolves to `undefined`.

`wardrik.run(id, input)` runs any operation by its ID, with path parameters in the input:

```ts
await wardrik.run("agent.ask", { agent: "acme/triage", content: "Hi" });
```

Agent IDs are `org/name`, or `org/@user/name` for a user's agent. A conversation, like one a
channel starts for a thread, adds one segment: `acme/triage/C1-1696.1234`.

## Asking

```ts
for await (const event of agent.stream("What's on fire?")) {
  if (event.type === "wardrik.message.delta") process.stdout.write(event.data.delta);

  if (event.type === "wardrik.run.interrupted") {
    for (const interrupt of event.data.interrupts) await agent.approve(interrupt.id);
  }
}

const reply = await agent.reply("Anything new?");
if (reply.status === "completed") console.log(reply.text);
```

| Method | Does |
| --- | --- |
| `ask` | Queues the message and returns it. |
| `stream` | Sends the message and yields the events of the run that answers it, until the run completes, fails or is cancelled. |
| `reply` | Sends the message and resolves when the run ends, or with the interrupts it waits on. |

An interrupt with reason `authorization` waits for a person to connect an account. No event
carries the sign-in link. Fetch it with `agent.authorization(interrupt.id)`, which resolves to
`{ url, code? }`. The token needs permission to decide the agent's calls. The call carries on by
itself once the person connects.

## Events

Every event is a CloudEvent with a `type` of `wardrik.<noun>.<verb>`. `WardrikEvent` is a union
over `type`, so checking `event.type` narrows `event.data`.

```ts
const events = agent.streamEvents({ after: saved });

for await (const event of events) {
  // …
}
```

A stream reconnects after any drop, including a server restart. It resumes after `events.cursor`:
the cursor of the last event it yielded that moved the cursor.

* A cursor is an opaque string. Pass it back as `after`.
* A snapshot's `cursor`, a sent message's `cursor` and a page's `next` are cursors too.
* Without `after`, a stream starts at the end of the log when it opens.
* Live events (text and reasoning deltas, tool progress and `wardrik.activity.changed`) don't move
  the cursor and aren't resent after a reconnect. `wardrik.message.completed` carries the whole
  text.
* If the log was trimmed past the cursor, a `wardrik.events.dropped` event says so.

`wardrik.events.streamList` follows many agents at once, by pattern. `wardrik.listen` passes each
event to the handler for its type, with the cursor after it:

```ts
await wardrik.listen(
  {
    "wardrik.run.completed": async (event, cursor) => {
      await db.transaction(async (tx) => {
        await tx.insertRun(event.id, event.data);
        await tx.saveCursor("runs", cursor);
      });
    },
  },
  { resources: ["acme/agent/*"], after: await db.cursor("runs") },
);
```

The server doesn't store your position. Save the cursor with your work and resume from it. Each
event is handled at least once, so drop repeats by `id`. `wardrik.events.dropped` is always sent,
whatever handlers you pass, so a gap never goes unseen.

A stream never ends by itself. To read a log to its end and stop, as a backfill does, read pages
with `agent.events` or `wardrik.events.list` until one is empty:

```ts
let after = saved;

for (;;) {
  const page = await wardrik.events.list({ resources: ["acme/agent/*"], after, limit: 500 });
  for (const event of page.events) await save(event);
  if (page.events.length === 0) break;
  after = page.next;
}
```

`page.next` is a cursor, so a stream can carry on from it.

## Tools

```ts
import { z } from "zod";

wardrik.tool({
  name: "refund_order",
  description: "Refund an order in full.",
  input: z.object({ orderId: z.string() }),
  idempotent: true,
  run: ({ orderId }, { idempotencyKey }) =>
    stripe.refunds.create({ payment_intent: orderId }, { idempotencyKey }),
});

await wardrik.work();
```

`work` holds a WebSocket open to the server and answers calls over it, as an MCP server, until
its `signal` aborts. The server offers the tools as `workers__<name>` to every agent the token may
serve whose tools include `workers/*`.

### `run`

* Returning an object makes it the call's result. Returning a string makes it text.
* Throwing fails the call, and the model is told.
* A tool that isn't `readOnly` is gated: a call waits on a person unless the agent's policy allows
  it by name.

Its second argument is a `ToolContext`:

* `agent` - the agent the call is for, `{ key, org, user?, name }`. The server sets it from the
  key the worker's token was checked against, never from what the model sent. A worker serving
  an agent per customer can answer each with only their data.
* `run` - the run the call is part of.
* `idempotencyKey` - the same each time the server runs this call. Pass it to whatever the tool
  changes.
* `signal` - aborts when the server stops waiting for the call, or the socket drops.
* `cost(usd)` - reports what the call cost. The call's `tool_call.completed` event carries it,
  and budgets count it.

### Reconnects

* The socket reopens whenever it drops, backing off up to 30 seconds.
* The worker pings the server every `keepalive` milliseconds, `15_000` unless set. If a ping goes
  unanswered for as long again, it drops the socket and reconnects.
* The server withdraws a worker's tools when its socket closes, and offers them again when it's
  back. Each turn uses the tools offered when it starts.
* A call running when the socket drops is aborted through its `signal`. It may have run. The
  server runs it again, with the same `idempotencyKey`, if every worker offering the tool marks it
  `idempotent` or `readOnly`. Otherwise it waits on a person to approve running it again.

`examples/refund.ts` runs a worker and an agent together.

## Errors

A request the API refuses throws a `WardrikError` with:

* `status` - the HTTP status.
* `type` - the error type, like `not_found` or `conflict`.
* `requestId` - the response's `request-id`, to quote when asking for help.

## Generated code

`src/protocol.ts` (the types) and `src/operations.ts` (the methods) are generated from
`../wardrik_protocol/priv/v1`, or the directory in `WARDRIK_PROTOCOL`. After the protocol
changes, run `npm run generate`. `npm run check` fails while either file is out of date.

```sh
npm ci
npm run check   # generated code, type check, tests
npm run build   # dist/
```
