# Changelog

## 0.1.0-rc.2 (2026-10-31)

- `providers.list`, `providers.add` and `providers.remove`: OAuth apps an org or person keeps for
  their people, and the events for adding and removing one. An MCP server names one as its
  `oauth.provider`.
- `notifyTargets.list`, `notifyTargets.add` and `notifyTargets.remove`: webhooks an org or person
  adds for their agents' notices, and the events for adding and removing one.
- `mcpServers.list` answers the servers an owner's agents reach, from further out too, and each
  server says its `owner` and `source`.

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
