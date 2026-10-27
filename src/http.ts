import { WardrikError } from "./errors.ts";

export interface Request {
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  signal?: AbortSignal | undefined;
  /** Statuses of 400 and above to answer with rather than throw on. */
  accept?: number[];
}

/** Requests to one server, as one token. */
export class Http {
  readonly url: string;
  readonly token: string;
  readonly #fetch: typeof fetch;

  constructor(url: string, token: string, fetcher: typeof fetch) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.#fetch = fetcher;
  }

  /** The response to `method` on `path`, throwing a `WardrikError` for 400 and above. */
  async send(method: string, path: string, request: Request = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, ...request.headers };

    let body: string | undefined;
    if (request.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(request.body);
    }

    const response = await this.#fetch(this.#address(path, request.query), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    if (response.status >= 400 && !request.accept?.includes(response.status)) {
      throw await WardrikError.from(response);
    }

    return response;
  }

  /** The JSON body of the answer to `method` on `path`, or `undefined` where it has none. */
  async json<T>(method: string, path: string, request: Request = {}): Promise<T> {
    const response = await this.send(method, path, request);
    const text = await response.text();
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  #address(path: string, query: Request["query"]): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      for (const one of [value ?? []].flat()) params.append(key, String(one));
    }

    const search = params.size > 0 ? `?${params}` : "";
    return this.url + path + search;
  }
}

const segment = (text: string): string => encodeURIComponent(text).replace(/^%40/, "@");

/**
 * An agent's ID as a path carries it: each segment of its ID, `org/name` or `org/@user/name`,
 * encoded on its own, with the `@` that marks a user kept, and a conversation after
 * `conversations/`, as `acme/triage/conversations/C1`.
 */
export function agentPath(id: string): string {
  const segments = id.split("/");
  const user = segments[1]?.startsWith("@") ?? false;
  const key = segments.slice(0, user ? 3 : 2);
  const conversation = segments.slice(key.length);

  const malformed =
    key.length < (user ? 3 : 2) ||
    conversation.length > 1 ||
    segments.some((part) => part === "" || part === "@") ||
    key.at(-1)!.startsWith("@");

  if (malformed) {
    throw new TypeError(`An agent's ID is org/name or org/@user/name, and a conversation's one more segment; got ${JSON.stringify(id)}`);
  }

  const path = key.map(segment).join("/");
  return conversation.length === 0 ? path : path + "/conversations/" + segment(conversation[0]!);
}
