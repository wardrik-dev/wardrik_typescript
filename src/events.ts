import { setTimeout as sleep } from "node:timers/promises";
import { WardrikError } from "./errors.ts";
import type { Http } from "./http.ts";
import type { EventOf, EventType, WardrikEvent } from "./protocol.ts";
import { messages } from "./sse.ts";

/** Where a stream reads from. */
export interface StreamFrom {
  /** The query each request carries, besides the cursor. */
  query?: Record<string, unknown>;
  /**
   * The cursor to read after: an event's, a page's `next`, a message's or a snapshot's. Without
   * it, the stream starts at the next event written.
   */
  after?: string | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Handlers for `wardrik.listen`, by event type. Each gets the event and the cursor after it, to
 * save with its work.
 */
export type Handlers = {
  [T in EventType]?: (event: EventOf<T>, cursor: string) => unknown;
};

/** Options for `wardrik.listen`. */
export interface ListenOptions {
  /** Patterns of the agents to follow, as `"acme/agent/*"`. Every agent the token can read unless set. */
  resources?: string[] | undefined;
  /** The cursor to resume after. The next event written unless set. */
  after?: string | undefined;
  signal?: AbortSignal | undefined;
}

const firstDelay = 250;
const lastDelay = 10_000;

/**
 * Agents' events after a cursor, as an async iterable.
 *
 * It reconnects after any drop, including a `kill -9` of the node, and resumes after the last
 * event it yielded that moved its cursor. It throws on a `WardrikError` below 500.
 *
 * Live events (streamed text and reasoning, and tool progress) don't move the cursor. A reconnect
 * doesn't resend the ones it missed. The `wardrik.message.completed` that follows has the whole
 * text.
 *
 * If the log was trimmed past the cursor, a `wardrik.events.dropped` event says so, and reading
 * resumes from the oldest event the log holds.
 *
 * It ends only when its signal aborts.
 */
export class EventStream implements AsyncIterable<WardrikEvent> {
  /** Resolves when the stream first opens. Rejects if it fails to open. */
  readonly opened: Promise<void>;

  readonly #http: Http;
  readonly #path: string;
  readonly #query: Record<string, unknown>;
  readonly #head: () => Promise<string>;
  readonly #signal: AbortSignal | undefined;
  #after: string | undefined;
  #open!: () => void;
  #fail!: (error: unknown) => void;

  /** @internal */
  constructor(http: Http, path: string, from: StreamFrom, head: () => Promise<string>) {
    this.#http = http;
    this.#path = path;
    this.#query = from.query ?? {};
    this.#head = head;
    this.#signal = from.signal;
    this.#after = from.after;

    this.opened = new Promise((resolve, reject) => {
      this.#open = resolve;
      this.#fail = reject;
    });
    this.opened.catch(() => {});
  }

  /** The cursor after the last event this stream yielded that moved it. */
  get cursor(): string | undefined {
    return this.#after;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<WardrikEvent> {
    const stop = new AbortController();
    const signal = this.#signal ? AbortSignal.any([this.#signal, stop.signal]) : stop.signal;

    try {
      yield* this.#stream(signal);
    } catch (error) {
      this.#fail(error);
      throw error;
    } finally {
      stop.abort();
    }
  }

  async *#stream(signal: AbortSignal): AsyncGenerator<WardrikEvent> {
    let delay = firstDelay;
    this.#after ??= await this.#head();

    while (!signal.aborted) {
      let response: Response;

      try {
        response = await this.#http.send("GET", this.#path, {
          headers: { accept: "text/event-stream", ...(this.#after === undefined ? {} : { "last-event-id": this.#after }) },
          query: this.#query,
          signal,
        });
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof WardrikError && error.status < 500) throw error;
        await sleep(delay, undefined, { signal }).catch(() => {});
        delay = Math.min(delay * 2, lastDelay);
        continue;
      }

      this.#open();
      delay = firstDelay;

      try {
        for await (const message of messages(response.body!)) {
          const event = JSON.parse(message.data) as WardrikEvent;
          if (message.id !== undefined) this.#after = message.id;
          yield event;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof SyntaxError) throw error;
      }

      await sleep(delay, undefined, { signal }).catch(() => {});
    }
  }
}

