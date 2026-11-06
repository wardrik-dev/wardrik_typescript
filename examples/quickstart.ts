// Set WARDRIK_URL and WARDRIK_TOKEN for a running server, then run node examples/quickstart.ts.
import { Wardrik } from "../src/index.ts";

const wardrik = new Wardrik();
const agent = wardrik.agent("agt_support");
await agent.define({
  model: "anthropic:claude-haiku-4-5",
  instructions: "Summarize incident reports.",
});
const reply = await agent.reply("The API returned errors for five minutes. About 200 requests failed.");
console.log(reply);
