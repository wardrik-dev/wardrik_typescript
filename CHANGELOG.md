# Changelog

## 0.1.0-rc.4 (2026-11-04)

- `TriggerDefinition.overlap` takes `"settle"`.
- `AgentDefinition.model_options`: `temperature`, `top_p`, `max_tokens`, `reasoning_effort`, and
  the model call's timeouts in seconds.
- `AgentDefinition.retries` documents `Retry-After`.

## 0.1.0-rc.3 (2026-11-03)

- A timeline's run has `subagent` steps.

- `agents.list` takes `limit` and `after`, and resolves to `{ agents, next }`, not the list.
- `listen`, `events.list` and `events.head` take `agents`, required: they read only the agents
  named.

## 0.1.0-rc.2 (2026-11-02)

- `wardrik.agent(id, { conversation })` acts on one of an agent's conversations. Its `stream` and
  `reply` follow that conversation.
- `wardrik.run` takes `conversation` for operations that act on one.
- Events carry `agent` and `conversation`. `agents.list` and `interrupts.list` items carry
  `conversation`.
- Event types `wardrik.provider.added`, `wardrik.provider.removed`, `wardrik.notify_target.added`
  and `wardrik.notify_target.removed`.

### Breaking

- Removed `tokens.*`, `secrets.*`, `ceilings.list`, `mcpServers.*` and `connections.*`, their types,
  and the `wardrik.token.*` events.
- An agent ID is any string. The SDK sends it as one URL-encoded path segment.
- Pass a conversation as `conversation`, not as part of the agent ID.
- `agents.list`, `agents.forget`, `agents.cancel`, `interrupts.list`, `events.list`, `events.head`
  and `wardrik.listen` filter by `agents`, a list of agent IDs, in place of `resources`.
- `ToolContext.agent` is the calling agent's ID, a string. `CallingAgent` is gone.
- `events.list` and `agent.events` pages hold `WardrikEvent`s, typed by `type`, as streams do.
- The `wardrik.ceiling.reached` event type is gone.
- An agent definition's `workspace.shared` entries name an `agent`, not a `tree`.
- `agents.list` items and `agent.read`'s `agent` have no `name`.

## 0.1.0-rc.1 (2026-10-30)

- `Wardrik`, a client for Wardrik's HTTP API, configured from `WARDRIK_URL` and `WARDRIK_TOKEN` or
  its options.
- A generated method for every operation in the protocol's `openapi.json`, and `run` for any by
  its ID.
- `ask`, `stream` and `reply`, to ask an agent and follow the run that answers.
- `WardrikEvent`, a union of the protocol's CloudEvents that narrows `data` by `type`.
- Event streams that reconnect after any drop, resuming after their cursor.
- Tools from your own process: `tool` with a `zod` input, and `work`, which offers them over a
  WebSocket. Each call gets an idempotency key, an abort signal and `cost`.
- `WardrikError`, with the HTTP status, the error type and the request ID.
- Node 22.18 or later, Bun or Deno.
