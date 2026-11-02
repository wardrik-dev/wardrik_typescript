import { EventStream } from "./events.ts";
import type { Http } from "./http.ts";
import { operations, type Inputs, type OperationId, type Outputs } from "./operations.ts";

/** Options for a call, besides its input. */
export interface CallOptions {
  signal?: AbortSignal | undefined;
}

/** Options for a stream, besides its input. */
export interface StreamOptions {
  /** Ends the stream. */
  signal?: AbortSignal | undefined;
}

type Entry = (typeof operations)[OperationId];
type Fields = Record<string, unknown>;

/** Runs operations by ID over HTTP, at the routes the protocol's document gives. */
export class Runner {
  readonly http: Http;

  /** @internal */
  constructor(http: Http) {
    this.http = http;
  }

  /** Runs operation `id` with `input` and returns its output. */
  async call<Id extends OperationId>(id: Id, input: Inputs[Id], options: CallOptions = {}): Promise<Outputs[Id]> {
    const entry: Entry = operations[id];
    const { path, query, body } = request(id, input as Fields);
    const answer = await this.http.json<Fields | undefined>(entry.method, path, { query, body, signal: options.signal });

    return ("unwrap" in entry ? answer?.[entry.unwrap] : answer) as Outputs[Id];
  }

  /** Returns an `EventStream` of the streamed operation `id`. */
  stream<Id extends OperationId>(id: Id, input: Inputs[Id], options: StreamOptions = {}): EventStream {
    const { path, query } = request(id, input as Fields);
    const { after, ...rest } = query;
    const head = () => this.#head(id, input as Fields);

    return new EventStream(this.http, path, { query: rest, after: after as string | undefined, signal: options.signal }, head);
  }

  // Where a log stands now, so a stream opened without a cursor holds one from the start.
  async #head(id: OperationId, input: Fields): Promise<string> {
    if (id === "agent.events") {
      const agent = { agent: input["agent"] as string, conversation: input["conversation"] as string | undefined };
      return (await this.call("agent.read", agent)).cursor;
    }

    return this.call("events.head", { agents: input["agents"] as string[] | undefined });
  }
}

// The request operation `id` makes. Given a conversation, it goes to the operation's conversation
// route, if it has one.
function request(id: OperationId, input: Fields) {
  const entry: Entry = operations[id];
  const route = "conversation" in entry ? entry.conversation : undefined;
  const conversation = input["conversation"] !== undefined;

  if (conversation && route === undefined) throw new TypeError(`${id} acts on an agent, not a conversation`);

  const params: string[] = [...entry.path_params, ...(conversation ? ["conversation"] : [])];
  const taken = new Set<string>([...entry.path_params, ...entry.query, ...(route === undefined ? [] : ["conversation"])]);
  const path = params.reduce((path, name) => path.replace(`{${name}}`, value(name, input[name])), conversation ? route! : entry.path);
  const query = Object.fromEntries(entry.query.map((name: string) => [name, input[name]]));
  const body = entry.body ? Object.fromEntries(Object.entries(input).filter(([name]) => !taken.has(name))) : undefined;

  return { path, query, body };
}

function value(name: string, given: unknown): string {
  if (typeof given !== "string" || given === "") throw new TypeError(`${name} is a string; got ${JSON.stringify(given)}`);
  return encodeURIComponent(given);
}
