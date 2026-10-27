# Wardrik SDK for TypeScript

Drives Wardrik agents over the HTTP API, and offers them tools that run in your own process, as
the npm package `@wardrik/sdk`, which is not published yet.

Node 22.18 or later, Bun or Deno. `zod` 4 is a peer dependency, for tool inputs.

## Connecting

```ts
import { Wardrik } from "@wardrik/sdk";

const wardrik = new Wardrik(); // WARDRIK_URL, else http://127.0.0.1:4747; WARDRIK_TOKEN
```

A token comes from the daemon, `wardrik token create NAME --resource 'acme/agent/*' --role
reader,messenger`, or from `wardrik.tokens.create` with a token owning `*`. It acts for whoever
made it, on the resources its patterns cover, holding the roles it was made with: each a named set
of actions, from `reader` to `owner`. An action it doesn't allow throws a `WardrikError` of type
`forbidden`, an expired token one of type `unauthorized`, and a revoked token closes its streams
and workers.

## Operations

Every operation in the protocol's `openapi.json` is a method, generated from it, so the SDK offers
what the server does and nothing else. An agent's are on `wardrik.agent(id)`, the rest on a
namespace named for the operation's prefix: `agents.list`, `tokens.create`, `mcpServers.add`,
`ceilings.list`. Path parameters come first, by position, then the rest of the input as one object,
named as the protocol names it:

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

An answer of one property is that property: `agents.list` answers the list, `agent.ask` the
message. An operation that answers nothing resolves to `undefined`. `wardrik.run(id, input)` runs
any operation by its id, with its path parameters in the input, as every other surface does.

An agent's ID is `org/name`, or `org/@user/name` for one that works for a user, and one of its
conversations, as a channel starts for a thread, is one segment more: `acme/triage/C1-1696.1234`.

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

`stream` sends a message and gives the events of the run that answers it, until that run
completes, fails or is cancelled. `reply` answers once it ends, or with the interrupts it waits
on. `ask` only queues the message.

An interrupt with reason `authorization` waits for a person to connect an account. No event
carries the link: `agent.authorization(interrupt.id)` answers it, `{ url, code? }`, to a token that
may decide the agent's calls. The call carries on by itself once the person has connected.

## Events

Every event is a CloudEvent whose `type` is `wardrik.<noun>.<verb>`, and `WardrikEvent` is a
union over `type`, so a check of `event.type` narrows `event.data`.

```ts
const events = agent.streamEvents({ after: saved });

for await (const event of events) {
  // …
}
```

A stream reconnects after any drop, a server's restart included, and resumes after the last event
it gave that moved its cursor, `events.cursor`: an opaque string, where the reader has got to in
each agent's log, which `after` takes back. A snapshot's `cursor` and a sent message's are one
too. Left without `after`, a stream starts where the log stood when it opened. Live events (text
and reasoning deltas, tool progress, and `wardrik.activity.changed`) move no cursor and aren't sent
again after a reconnect; `wardrik.message.completed` carries the whole text. Where a log was
trimmed past the cursor, a `wardrik.events.dropped` says so.

`wardrik.events.streamList` follows many agents at once, by pattern, and `wardrik.listen` hands
each event to a handler of its type with the cursor past it:

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

The server keeps no reader's place, so keep the cursor with what you did, and read on from it. A
`wardrik.events.dropped` comes whatever the types, so a gap never passes unseen.

A stream never ends by itself. To read what a log holds and stop, as a backfill does, read its
pages, `agent.events` or `wardrik.events.list`, each from the last one's `next`, until one comes
back empty:

```ts
let after = saved;

for (;;) {
  const page = await wardrik.events.list({ resources: ["acme/agent/*"], after, limit: 500 });
  for (const event of page.events) await save(event);
  if (page.events.length === 0) break;
  after = page.next;
}
```

`page.next` is a cursor too, so a stream can carry on from it.

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

`work` holds a WebSocket to the server open and answers calls over it, as an MCP server, until its
`signal` aborts. The server offers the tools, as `workers__<name>`, to every agent the token may
serve whose tools name `workers/*`.

The socket is opened again whenever it drops, waiting longer each time up to 30 seconds. The worker
pings the server every `keepalive` milliseconds, 15 seconds unless set, and drops a socket whose
ping goes unanswered as long again, so a server that went away without closing it isn't waited on.
The server withdraws a worker's tools the moment its socket goes, and offers them again once it's
back: an agent takes the tools offered as each turn starts, and each call goes to a worker
connected then. A call running when the socket drops is aborted through its `signal`. It may have
run, so the server runs it again, under the same `idempotencyKey`, where every worker offering the
tool marks it `idempotent` or `readOnly`, on whichever worker offers it by then, and otherwise
waits on a person to approve running it again.

`agent` is the agent a call is made for, `{ key, org, user?, name }`, which the server names from
the key the worker's token was checked against, never from what the model sent: a worker serving
an agent for each customer answers each with what is theirs. `run` is the run the call is part of.

`idempotencyKey` is the same each time the server runs one call: pass it on to what the tool
changes. A tool that isn't `readOnly` is gated: a call to it waits on a person unless the agent's
policy allows it by name. `cost(usd)` says what the call cost, which its `tool_call.completed`
carries and a budget counts.

`run` answers an object as the call's result and a string as text. A thrown error is a failed
call the model is told about.

`examples/refund.ts` runs a worker and an agent together.

## Errors

A request the API refuses throws a `WardrikError`, with the answer's `status`, its `type`
(`not_found`, `conflict` and so on), and its `requestId`.

## Generated code

`src/protocol.ts`, the types, and `src/operations.ts`, the methods, are generated from
`../wardrik_protocol/priv/v1`, or `WARDRIK_PROTOCOL`. After the protocol changes, run
`npm run generate`; `npm run check` fails while either is out of date.

```sh
npm ci
npm run check   # generated code, type check, tests
npm run build   # dist/
```
