/** One server-sent event: its `id:` line, if it had one, and its data. */
export interface Message {
  id: string | undefined;
  data: string;
}

/** The server-sent events a response body carries, in order. */
export async function* messages(body: ReadableStream<Uint8Array>): AsyncGenerator<Message> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let id: string | undefined;

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    let end: number;
    while ((end = buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + (buffer.startsWith("\r\n", end) ? 2 : 1));

      if (line === "") {
        if (data.length > 0) yield { id, data: data.join("\n") };
        data = [];
        id = undefined;
        continue;
      }

      if (line.startsWith(":")) continue;

      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");

      if (field === "data") data.push(value);
      if (field === "id") id = value;
    }
  }
}
