// An agent that refunds orders through a tool running in this process.
//
//   wardrik token create shop --resource 'acme/agent/*' --role owner
//   WARDRIK_TOKEN=wrk_… WARDRIK_MODEL=anthropic:claude-sonnet-4-5 node examples/refund.ts

import { z } from "zod";
import { Wardrik } from "../src/index.ts";

const wardrik = new Wardrik({ name: "shop" });
const stop = new AbortController();

wardrik.tool({
  name: "refund_order",
  description: "Refund an order in full.",
  input: z.object({ orderId: z.string() }),
  idempotent: true,
  run: ({ orderId }, { idempotencyKey }) => {
    console.log(`\n[worker] refunding ${orderId} under ${idempotencyKey}`);
    return { refund: `re_${orderId}`, status: "succeeded" };
  },
});

const working = wardrik.work({ signal: stop.signal });

const agent = wardrik.agent("acme/refunds");
await agent.define({
  model: process.env.WARDRIK_MODEL ?? "anthropic:claude-sonnet-4-5",
  instructions: "You refund orders when asked, with refund_order, and say what you did.",
  tools: ["workers/*"],
});

for await (const event of agent.stream("Please refund order o_42.")) {
  switch (event.type) {
    case "wardrik.message.delta":
      process.stdout.write(event.data.delta);
      break;
    case "wardrik.tool_call.started":
      console.log(`\n[agent] calling ${event.data.tool.name}`);
      break;
    case "wardrik.run.interrupted":
      for (const interrupt of event.data.interrupts) {
        console.log(`\n[agent] waiting on: ${interrupt.message}; approving`);
        await agent.approve(interrupt.id);
      }
      break;
    case "wardrik.run.completed":
    case "wardrik.run.failed":
    case "wardrik.run.cancelled":
      console.log(`\n[agent] ${event.type.slice("wardrik.run.".length)}`);
      break;
  }
}

stop.abort();
await working;
