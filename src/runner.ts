import { EventStream } from "./events.ts";
import { agentPath, type Http } from "./http.ts";
import { operations, type Inputs, type OperationId, type Outputs } from "./operations.ts";

/** What a call takes beside its input. */
export interface CallOptions {
  signal?: AbortSignal | undefined;
}

/** What a stream takes beside its input. */
export interface StreamOptions {
  /** Ends the stream. */
  signal?: AbortSignal | undefined;
}

type Entry = (typeof operations)[OperationId];
type Fields = Record<string, unknown>;

/** Runs operations by their id, over HTTP, as the protocol's document routes them. */
export class Runner {
  readonly http: Http;

  /** @internal */
  constructor(http: Http) {
    this.http = http;
  }

  /** Runs the operation `id` with `input`, and answers what it answers. */
  async call<Id extends OperationId>(id: Id, input: Inputs[Id], options: CallOptions = {}): Promise<Outputs[Id]> {
    const entry: Entry = operations[id];
    const { path, query, body } = request(entry, input as Fields);
    const answer = await this.http.json<Fields | undefined>(entry.method, path, { query, body, signal: options.signal });

    return ("unwrap" in entry ? answer?.[entry.unwrap] : answer) as Outputs[Id];
  }

  /** Follows the events the streamed operation `id` reads. */
  stream<Id extends OperationId>(id: Id, input: Inputs[Id], options: StreamOptions = {}): EventStream {
    const { path, query } = request(operations[id], input as Fields);
    const { after, ...rest } = query;
    const head = () => this.#head(id, input as Fields);

    return new EventStream(this.http, path, { query: rest, after: after as string | undefined, signal: options.signal }, head);
  }

  // Where a log stands now, so a stream opened without a cursor holds one from the start.
  async #head(id: OperationId, input: Fields): Promise<string> {
    if (id === "agent.events") return (await this.call("agent.read", { agent: input["agent"] as string })).cursor;
    return this.call("events.head", { resources: input["resources"] as string[] | undefined });
  }
}

function request(entry: Entry, input: Fields) {
  const taken = new Set<string>([...entry.path_params, ...entry.query]);
  const path = entry.path_params.reduce((path: string, name: string) => path.replace(`{${name}}`, value(name, input[name])), entry.path);
  const query = Object.fromEntries(entry.query.map((name: string) => [name, input[name]]));
  const body = entry.body ? Object.fromEntries(Object.entries(input).filter(([name]) => !taken.has(name))) : undefined;

  return { path, query, body };
}

function value(name: string, given: unknown): string {
  if (typeof given !== "string" || given === "") throw new TypeError(`${name} is a string; got ${JSON.stringify(given)}`);
  return name === "agent" ? agentPath(given) : encodeURIComponent(given);
}
