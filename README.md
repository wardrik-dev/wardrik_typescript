# Wardrik SDK for TypeScript

Drive Wardrik agents over HTTP, and give them tools that run in your own process.

```sh
npm install @wardrik/sdk@0.1.0-rc.2 zod
```

Runs on Node 22.18+, Bun or Deno. `zod` 4 is a peer dependency, for tool inputs.

## Connect

```ts
import { Wardrik } from "@wardrik/sdk";

const wardrik = new Wardrik({ url: "http://127.0.0.1:4747", token: process.env.WARDRIK_TOKEN });
```

* `url` defaults to `WARDRIK_URL`, then `http://127.0.0.1:4747`.
* `token` defaults to `WARDRIK_TOKEN`. It is sent as `Authorization: Bearer`.
* Without a token, `new Wardrik()` throws a `TypeError`.

## Agents

```ts
const agent = wardrik.agent("support-bot");

await agent.define({
  model: "anthropic:claude-sonnet-4-5",
  instructions: "You watch the incident queue.",
  tools: ["linear/*", "workers/*"],
});

const reply = await agent.reply("Anything on fire?");
if (reply.status === "completed") console.log(reply.text);

for await (const event of agent.stream("And now?")) {
  if (event.type === "wardrik.message.delta") process.stdout.write(event.data.delta);
}
```

* `ask` queues a message. `stream` yields the events of the run that answers it. `reply` resolves when that run ends.
* A run waiting on a person gives `reply.status === "waiting"` and its `interrupts`.
  Answer with `agent.approve(interrupt.id)` or `agent.deny(interrupt.id)`.
* An interrupt with reason `authorization` waits for a person to connect an account.
  `agent.authorization(interrupt.id)` gives the `{ url, code? }` to show them.
* An agent ID is any string your app picks.

## Conversations

```ts
const thread = wardrik.agent("support-bot", { conversation: "C1-1696.1234" });

await thread.reply("Is the deploy done?");
await thread.clear();
```

* Each conversation has its own history and shares the agent's definition.
* `define`, `forget`, `spawn` and the trigger methods always act on the agent.

## Other operations

Every operation in the protocol is a method. Those not on an agent live on namespaces:

```ts
const agents = await wardrik.agents.list({ agents: ["support-bot", "billing-bot"] });

await wardrik.run("agent.ask", { agent: "support-bot", conversation: "C1", content: "Hi" });
```

* A response with one field resolves to that field, so `agents.list` resolves to the list.
* `wardrik.run(id, input)` runs any operation by its ID.

## Events

```ts
for await (const event of agent.streamEvents({ after: saved })) {
  console.log(event.type, event.data);
}
```

* Checking `event.type` narrows `event.data`.
* A stream reconnects on its own and resumes after its `cursor`. Save it and pass it back as `after`.
* Without `after`, a stream starts at the end of the log.
* Deltas and tool progress are not resent after a reconnect. `wardrik.message.completed` has the whole text.
* `wardrik.events.dropped` says the log was trimmed past your cursor.

Handle events from many agents by type:

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
  { agents: ["support-bot"], after: await db.cursor("runs") },
);
```

Each event arrives at least once. Drop repeats by `event.id`.

A stream never ends. To backfill, read pages until one is empty:

```ts
for (let after = saved; ; ) {
  const page = await wardrik.events.list({ agents: ["support-bot"], after, limit: 500 });
  if (page.events.length === 0) break;
  for (const event of page.events) await save(event);
  after = page.next;
}
```

## Tools

```ts
import { z } from "zod";

wardrik.tool({
  name: "refund_order",
  description: "Refund an order in full.",
  input: z.object({ orderId: z.string() }),
  idempotent: true,
  run: async ({ orderId }, { idempotencyKey, cost }) => {
    const refund = await stripe.refunds.create({ payment_intent: orderId }, { idempotencyKey });
    cost(0.01);
    return { refund: refund.id };
  },
});

await wardrik.work({ signal });
```

* `work` keeps a WebSocket open and answers calls until `signal` aborts. It reconnects on its own.
* Agents whose `tools` include `workers/*` see the tool as `workers__refund_order`.
* Return an object or a string. Throw to fail the call.
* A tool not marked `readOnly` waits for a person's approval, unless the agent's policy allows it.
* The context's `agent` is the calling agent's ID. Use it to scope data per agent.
* A call cut off by a dropped socket runs again only if the tool is `idempotent` or `readOnly`.
  It gets the same `idempotencyKey`.

`examples/refund.ts` runs a worker and an agent together.

## Errors

A refused request throws a `WardrikError` with `status`, `type` (like `not_found` or `forbidden`) and `requestId`.

## Development

`src/protocol.ts` and `src/operations.ts` are generated from `../wardrik_protocol/priv/v1`, or `WARDRIK_PROTOCOL`.

```sh
npm ci
npm run generate  # after the protocol changes
npm run check     # generated code, types, tests
npm run build     # dist/
```
