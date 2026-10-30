import { WardrikError } from "./errors.ts";

export interface Request {
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  signal?: AbortSignal | undefined;
  /** Statuses of 400 and above to return instead of throwing. */
  accept?: number[];
}

/** Makes requests to one server with one token. */
export class Http {
  readonly url: string;
  readonly token: string;
  readonly #fetch: typeof fetch;

  constructor(url: string, token: string, fetcher: typeof fetch) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.#fetch = fetcher;
  }

  /** Sends `method` to `path`. Throws a `WardrikError` for a status of 400 or above. */
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

  /** Sends `method` to `path` and returns the JSON body, or `undefined` if it's empty. */
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
 * Returns an agent's ID as a URL path.
 *
 * Each segment is percent-encoded on its own, keeping a user's leading `@`. A conversation goes
 * after `conversations/`, as `acme/triage/conversations/C1`. Throws a `TypeError` for a malformed
 * ID.
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
