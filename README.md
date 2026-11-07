# Wardrik SDK for TypeScript

Send messages to Wardrik agents over HTTP and run agent tools in your TypeScript process.

```sh
npm install @wardrik/sdk@0.1.0-rc.5 zod
```

Runs on Node 22.18+, Bun or Deno. `zod` 4 is a peer dependency, for tool inputs.

## Connect

Start a [Wardrik daemon](https://docs.wardrik.dev/getting-started/quickstart/) and configure its model provider key.
For a local daemon, export the CLI token before running Node:

```sh
export WARDRIK_URL=http://127.0.0.1:4747
export WARDRIK_TOKEN="$(cat "${WARDRIK_DATA_HOME:-$HOME/.local/share/wardrik}/cli_token")"
```

For a remote server, use a token issued by that server.

Save the connection and agent examples below in `agent.ts`, then run `node agent.ts` on Node 22.18+.

```ts
import { Wardrik } from "@wardrik/sdk";

const wardrik = new Wardrik();
```

* `url` defaults to `WARDRIK_URL`, then `http://127.0.0.1:4747`.
* `token` defaults to `WARDRIK_TOKEN`. It is sent as `Authorization: Bearer`.
* Without a token, `new Wardrik()` throws a `TypeError`.

## Agents

```ts
const agent = wardrik.agent("agt_support");

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

Continue in the same file, using the connected client:

```ts
const thread = wardrik.agent("agt_support", { conversation: "C1-1696.1234" });

await thread.reply("Is the deploy done?");
await thread.clear();
```

* Each conversation has its own history and shares the agent's definition.
* `define`, `forget`, `spawn` and the trigger methods always act on the agent.

## Other operations

The following fragments use the connected `wardrik` client.

Every operation in the protocol is a method. Those not on an agent live on namespaces:

```ts
const { agents, next } = await wardrik.agents.list({ limit: 100 });
const more = next ? await wardrik.agents.list({ limit: 100, after: next }) : undefined;

await wardrik.run("agent.ask", { agent: "agt_support", conversation: "C1", content: "Hi" });
```

* A response with one field resolves to that field, so `interrupts.list` resolves to the list.
* `wardrik.run(id, input)` runs any operation by its ID.

## Events

Continue with the client and agent above. This stream runs for 30 seconds:

```ts
for await (const event of agent.streamEvents({}, { signal: AbortSignal.timeout(30_000) })) {
  console.log(event.type, event.data);
}
```

* Checking `event.type` narrows `event.data`.
* A stream reconnects on its own and resumes after its `cursor`. Save it and pass it back as `after`.
* Without `after`, a stream starts at the end of the log.
* Deltas and tool progress are not resent after a reconnect. `wardrik.message.completed` has the whole text.
* `wardrik.events.dropped` says the log was trimmed past your cursor.

Database integration fragment: implement `db.transaction`, `insertRun`, `saveCursor`, and `cursor` in your app.
Save the event and cursor in one transaction:

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
  { agents: ["agt_support"], after: await db.cursor("runs") },
);
```

Each event arrives at least once. Drop repeats by `event.id`.

To backfill, read pages until one is empty. This fragment logs each event:

```ts
for (let after: string | undefined; ; ) {
  const page = await wardrik.events.list({ agents: ["agt_support"], after, limit: 500 });
  if (page.events.length === 0) break;
  for (const event of page.events) console.log(event.type, event.data);
  after = page.next;
}
```

## Tools

This worker uses a read-only tool and stops after 30 seconds. Use the connected client above.

```ts
import { z } from "zod";

wardrik.tool({
  name: "order_status",
  description: "Return an example order status.",
  input: z.object({ orderId: z.string() }),
  readOnly: true,
  run: ({ orderId }) => ({ orderId, status: "shipped" }),
});

await wardrik.work({ signal: AbortSignal.timeout(30_000) });
```

* `work` keeps a WebSocket open and answers calls until `signal` aborts. It reconnects on its own.
* Agents whose `tools` include `workers/*` see the tool as `workers__order_status`.
* Return an object or a string. Throw to fail the call.
* A tool not marked `readOnly` waits for a person's approval, unless the agent's policy allows it.
* The context's `agent` is the calling agent's ID. Use it to scope data per agent.
* A call cut off by a dropped socket runs again only if the tool is `idempotent` or `readOnly`.
  It gets the same `idempotencyKey`.

From a repository checkout, run the simulated refund example:

```sh
npm ci
node examples/refund.ts
```

It starts a worker and agent together and automatically approves example calls. It does not issue real refunds.

## Errors

A refused request throws a `WardrikError` with `status`, `type` (like `not_found` or `forbidden`) and `requestId`.

## Development

Run these commands from a repository checkout:

`src/protocol.ts` and `src/operations.ts` are generated from `../wardrik_protocol/priv/v1`, or `WARDRIK_PROTOCOL`.

```sh
npm ci
npm run generate  # after the protocol changes
npm run check     # generated code, types, tests
npm run build     # dist/
```
