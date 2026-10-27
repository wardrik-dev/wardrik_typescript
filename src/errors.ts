import type { ErrorBody } from "./protocol.ts";

/** What went wrong, as the API answered it: its status and error body. */
export class WardrikError extends Error {
  /** The HTTP status. */
  readonly status: number;
  /** A low-cardinality code, such as `not_found` or `conflict`. */
  readonly type: ErrorBody["error"]["type"] | "unknown";
  /** The `Request-Id` the API answered with, to quote when asking for help. */
  readonly requestId: string | undefined;

  constructor(status: number, error: { type: WardrikError["type"]; message: string }, requestId?: string | undefined) {
    super(error.message);
    this.name = "WardrikError";
    this.status = status;
    this.type = error.type;
    this.requestId = requestId;
  }

  /** The error an answer of 400 or above holds. */
  static async from(response: Response): Promise<WardrikError> {
    const requestId = response.headers.get("request-id") ?? undefined;

    try {
      const body = (await response.json()) as ErrorBody;
      return new WardrikError(response.status, body.error, requestId);
    } catch {
      const message = `${response.status} ${response.statusText}`.trim();
      return new WardrikError(response.status, { type: "unknown", message }, requestId);
    }
  }
}
