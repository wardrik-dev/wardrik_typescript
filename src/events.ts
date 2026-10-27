import { setTimeout as sleep } from "node:timers/promises";
import { WardrikError } from "./errors.ts";
import type { Http } from "./http.ts";
import type { EventOf, EventType, WardrikEvent } from "./protocol.ts";
import { messages } from "./sse.ts";

/** Where a stream reads from, and what it reads. */
export interface StreamFrom {
  /** The query the stream's requests carry, beside the cursor. */
  query?: Record<string, unknown>;
  /**
   * The cursor to read after: an event's, a page's `next`, a message's or a snapshot's. Left out,
   * the stream starts at what is written next.
   */
  after?: string | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * What `wardrik.listen` hands each event of a type to: the event, and the cursor past it, to keep
 * with what the handler does.
 */
export type Handlers = {
  [T in EventType]?: (event: EventOf<T>, cursor: string) => unknown;
};

/** Where `wardrik.listen` reads from, and until when. */
export interface ListenOptions {
  /** The agents each pattern covers, as `"acme/agent/*"`; every agent the token reads where left out. */
  resources?: string[] | undefined;
  /** The cursor to carry on after; what is written next where left out. */
  after?: string | undefined;
  signal?: AbortSignal | undefined;
}

const firstDelay = 250;
const lastDelay = 10_000;

/**
 * Agents' events, after a cursor on: an async iterable that reconnects after any drop, a `kill -9`
 * of the node included, and resumes after the last event it gave that moved its cursor.
 *
 * Live events, text and reasoning as it streams and tool progress, move no cursor, and a reconnect
 * does not send again what was missed of them; the `wardrik.message.completed` that follows has
 * the whole text. Where a log was trimmed past the cursor, a `wardrik.events.dropped` says so, and
 * the log is read on from the oldest event it holds.
 *
 * It ends when its signal aborts.
 */
export class EventStream implements AsyncIterable<WardrikEvent> {
  /** Settles once the stream is first open, or fails to open. */
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

  /** The cursor after the last event this stream has given that moved it. */
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

