import type { ErrorBody } from "./protocol.ts";

/** An error response from the API. */
export class WardrikError extends Error {
  /** The HTTP status. */
  readonly status: number;
  /** The error type, such as `not_found` or `conflict`. */
  readonly type: ErrorBody["error"]["type"] | "unknown";
  /** The response's `request-id`. Quote it when asking for help. */
  readonly requestId: string | undefined;

  constructor(status: number, error: { type: WardrikError["type"]; message: string }, requestId?: string | undefined) {
    super(error.message);
    this.name = "WardrikError";
    this.status = status;
    this.type = error.type;
    this.requestId = requestId;
  }

  /** Reads the error from a failed response. Its `type` is `unknown` if the body isn't an error. */
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
