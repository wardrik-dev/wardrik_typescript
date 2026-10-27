// A stand-in for a Wardrik server: it records each request and answers with
// what the test gives each route.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Received {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export type Handler = (request: Received, response: ServerResponse) => void | Promise<void>;

export interface Fake {
  url: string;
  received: Received[];
  /** Answers `method path` with `handler`; the handlers of a route are used in turn, the last one again. */
  on(method: string, path: string, handler: Handler): void;
  close(): Promise<void>;
}

export async function fake(): Promise<Fake> {
  const routes = new Map<string, Handler[]>();
  const received: Received[] = [];

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();

    const url = new URL(request.url!, "http://fake");
    const entry: Received = {
      method: request.method!,
      path: url.pathname + url.search,
      headers: request.headers,
      body: text ? JSON.parse(text) : undefined,
    };
    received.push(entry);

    const handlers = routes.get(`${request.method} ${url.pathname}`);
    const handler = handlers && (handlers.length > 1 ? handlers.shift() : handlers[0]);

    if (!handler) return json(response, 404, error("not_found", "No such route."));
    await handler(entry, response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    received,
    on(method, path, handler) {
      const key = `${method} ${path}`;
      routes.set(key, [...(routes.get(key) ?? []), handler]);
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function json(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "request-id": "req_test" });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

export const error = (type: string, message: string, fields: object = {}) => ({
  error: { type, message, ...fields },
});

const traceOf = (run: string) => `00-${run}-00f067aa0ba902b7-01`;

/** A CloudEvent of `type`, in the run `run`, durable where it has a sequence. */
export function event(type: string, data: object, options: { sequence?: number; run?: string } = {}) {
  const run = options.run ?? "a".repeat(32);

  return {
    specversion: "1.0",
    id: crypto.randomUUID(),
    source: "wardrik://test/agents/acme/triage",
    type: `wardrik.${type}`,
    subject: "runs/" + run,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    dataschema: `urn:wardrik:schema:v1:${type}`,
    ...(options.sequence === undefined
      ? {}
      : { sequence: String(options.sequence).padStart(12, "0") }),
    traceparent: traceOf(run),
    data,
  };
}

/** Opens an event stream and writes `events`, then ends it where `end` says. */
export function stream(events: ReturnType<typeof event>[], options: { end?: boolean } = {}): Handler {
  return (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": open\n\n");

    for (const event of events) {
      const id = event.sequence ? `id: ${event.sequence}\n` : "";
      response.write(`${id}data: ${JSON.stringify(event)}\n\n`);
    }

    if (options.end ?? true) response.end();
  };
}
