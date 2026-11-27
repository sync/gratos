// The request body limit (docs/plan.html, follow-up F1): createServer({ maxBodyBytes }), default
// 1 MiB. A body over it gets a 413 transport error before onParams, the context factory or any
// resolver runs: by its Content-Length (plain decimal digits) without being read, else once the
// bytes read pass the limit. Through handle(Request) with counted body sources, and over a real
// Node socket with a raw sender.
import { once } from "node:events";
import { connect } from "node:net";
import type { Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../src/index.ts";
import type { Plugin } from "../src/index.ts";
import { flush, send, URL_ } from "./support/http.ts";
import { basicSchema } from "./support/schema.ts";
import { listen } from "./support/stream.ts";
import type { Listening } from "./support/stream.ts";

const GRJ = "application/graphql-response+json; charset=utf-8";

const encoder = new TextEncoder();

/** A body source that counts what is pulled from it and whether it was cancelled. */
interface Source {
  readonly stream: ReadableStream<Uint8Array>;
  /** Pull calls made by the consumer. */
  readonly pulls: () => number;
  /** Bytes handed to the consumer. */
  readonly pulled: () => number;
  /** Calls of the source's `cancel`. */
  readonly cancels: () => number;
}

/**
 * A source that hands out `chunks` one per pull (high-water mark 0, so nothing is pulled before
 * the consumer reads), then closes. `cancel` is what its cancel returns. Each pull waits a turn of
 * the event loop: a reader with no limit on an endless source then times out, instead of filling
 * the memory in one synchronous loop.
 */
const source = (
  chunks: Iterable<Uint8Array>,
  cancel: () => Promise<void> | void = () => {},
): Source => {
  const iterator = chunks[Symbol.iterator]();
  let pulls = 0;
  let pulled = 0;
  let cancels = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        pulls += 1;
        await flush();
        const next = iterator.next();
        if (next.done === true) {
          controller.close();
          return;
        }
        pulled += next.value.byteLength;
        controller.enqueue(next.value);
      },
      cancel: () => {
        cancels += 1;
        return cancel();
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls, pulled: () => pulled, cancels: () => cancels };
};

/** `size`-byte chunks, forever: a chunked upload that never ends. */
function* endless(size: number): Generator<Uint8Array> {
  for (;;) {
    yield new Uint8Array(size).fill(0x20);
  }
}

/** `bytes`, split into chunks at `at` (offsets into the bytes). */
const splitAt = (bytes: Uint8Array, at: ReadonlyArray<number>): Array<Uint8Array> => {
  const chunks: Array<Uint8Array> = [];
  let start = 0;
  for (const end of [...at, bytes.byteLength]) {
    chunks.push(bytes.slice(start, end));
    start = end;
  }
  return chunks;
};

/** A POST whose body is `stream`, with no Content-Length unless `headers` give one. */
const streamed = (stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: stream,
    duplex: "half",
  });

/** A JSON body that asks for `hello(name: $name)`. */
const helloBody = (name: string): string =>
  JSON.stringify({ query: "query ($name: String) { hello(name: $name) }", variables: { name } });

/** A `{ count }` request padded with an unused variable to exactly `bytes` bytes. */
const countBodyOf = (bytes: number): string => {
  const empty = JSON.stringify({ query: "{ count }", variables: { pad: "" } });
  return JSON.stringify({
    query: "{ count }",
    variables: { pad: "x".repeat(bytes - empty.length) },
  });
};

/** What a server saw past the read phase, and its onResponse calls. */
const counted = (maxBodyBytes?: number) => {
  const seen = { params: 0, context: 0, resolver: 0, responses: [] as Array<number> };
  const plugin: Plugin = {
    onParams: () => {
      seen.params += 1;
    },
    onResponse: (response) => {
      seen.responses.push(response.status);
    },
  };
  const server = createServer({
    schema: basicSchema({
      Query: {
        hello: (_source, args: { name?: string }) => {
          seen.resolver += 1;
          return `hello ${args.name ?? "world"}`;
        },
        count: () => {
          seen.resolver += 1;
          return 1;
        },
      },
    }),
    context: () => {
      seen.context += 1;
      return undefined;
    },
    plugins: [plugin],
    maxBodyBytes,
  });
  return { server, seen };
};

const tooLarge = (limit: number) => ({
  errors: [{ message: `The request body is larger than ${limit} bytes.` }],
});

describe("a declared Content-Length over the limit", () => {
  it("gets 413 without the body being read: its source is never pulled", async () => {
    const { server, seen } = counted(1000);
    const body = source(endless(100));
    const sent = await send(server, streamed(body.stream, { "content-length": "1001" }));
    expect(sent.status).toBe(413);
    expect(sent.headers.get("content-type")).toBe(GRJ);
    expect(sent.body).toEqual(tooLarge(1000));
    expect(body.pulls()).toBe(0);
    expect(seen).toEqual({ params: 0, context: 0, resolver: 0, responses: [413] });
  });

  it("is a 413 as JSON for every client: application/json, and an SSE-only client", async () => {
    const { server } = counted(10);
    const json = await send(
      server,
      streamed(source(endless(1)).stream, { "content-length": "11", accept: "application/json" }),
    );
    expect(json.status).toBe(413);
    expect(json.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const sse = await send(
      server,
      streamed(source(endless(1)).stream, { "content-length": "11", accept: "text/event-stream" }),
    );
    expect(sse.status).toBe(413);
    expect(sse.headers.get("content-type")).toBe(GRJ);
    expect(sse.body).toEqual(tooLarge(10));
  });
});

describe("a body with no length", () => {
  it("gets 413 after at most the limit plus one chunk, cancels its source, and runs nothing", async () => {
    const { server, seen } = counted(4096);
    const body = source(endless(1000));
    const sent = await send(server, streamed(body.stream));
    expect(sent.status).toBe(413);
    expect(sent.body).toEqual(tooLarge(4096));
    expect(body.pulled()).toBeGreaterThan(4096);
    expect(body.pulled()).toBeLessThanOrEqual(4096 + 1000);
    expect(body.cancels()).toBe(1);
    expect(seen).toEqual({ params: 0, context: 0, resolver: 0, responses: [413] });
  });

  it("never waits on the reader's cancellation, even one that never settles", async () => {
    const { server } = counted(4096);
    const neverSettles = Promise.withResolvers<void>();
    const body = source(endless(1000), () => neverSettles.promise);
    // A 413 that waited on the cancel would never resolve: the test would time out.
    const sent = await send(server, streamed(body.stream));
    expect(sent.status).toBe(413);
    expect(body.cancels()).toBe(1);
  });
});

describe("a Content-Length that is not the truth", () => {
  it("smaller than the bytes sent: the body is still stopped at the limit", async () => {
    const { server, seen } = counted(4096);
    const body = source(endless(1000));
    const sent = await send(server, streamed(body.stream, { "content-length": "10" }));
    expect(sent.status).toBe(413);
    expect(body.pulled()).toBeLessThanOrEqual(4096 + 1000);
    expect(body.cancels()).toBe(1);
    expect(seen.params).toBe(0);
  });

  it.each(["1e9", "0x10", "1.5", "abc"])(
    "not plain decimal digits (%s): ignored, and the body is counted",
    async (contentLength) => {
      const { server } = counted(4096);
      const body = source(endless(1000));
      const sent = await send(server, streamed(body.stream, { "content-length": contentLength }));
      expect(sent.status).toBe(413);
      expect(body.pulled()).toBeGreaterThan(4096);
      expect(body.pulled()).toBeLessThanOrEqual(4096 + 1000);
    },
  );

  it("Content-Length: 1e9 with a valid body under the limit is served", async () => {
    const { server } = counted(4096);
    const sent = await send(
      server,
      streamed(source([encoder.encode(helloBody("ada"))]).stream, { "content-length": "1e9" }),
    );
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ data: { hello: "hello ada" } });
  });
});

describe("chunks request.text() would refuse", () => {
  it("a body a caller has already started reading gets 400, even when the rest is valid JSON", async () => {
    // The first chunk is whitespace, and the rest is a complete JSON body under the limit: only
    // the earlier read refuses it.
    const { server, seen } = counted(100);
    const json = encoder.encode(countBodyOf(60));
    const request = streamed(source([encoder.encode("   "), json]).stream);
    const reader = request.body?.getReader();
    await reader?.read();
    reader?.releaseLock();
    const sent = await send(server, request);
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({ errors: [{ message: "The request body is not valid JSON." }] });
    expect(seen.resolver).toBe(0);
  });

  it("a DataView chunk gets 400, as request.text() rejects it", async () => {
    const { server, seen } = counted();
    const json = encoder.encode(countBodyOf(60));
    const stream = new ReadableStream({
      start: (controller) => {
        controller.enqueue(new DataView(json.buffer));
        controller.close();
      },
    });
    const sent = await send(
      server,
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      }),
    );
    expect(sent.status).toBe(400);
    expect(seen.resolver).toBe(0);
  });

  it("a DataView whose Symbol.toStringTag says Uint8Array still gets 400", async () => {
    const { server } = counted();
    const json = encoder.encode(countBodyOf(60));
    const view = new DataView(json.buffer);
    Object.defineProperty(view, Symbol.toStringTag, { value: "Uint8Array" });
    const stream = new ReadableStream({
      start: (controller) => {
        controller.enqueue(view);
        controller.close();
      },
    });
    const sent = await send(
      server,
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      }),
    );
    expect(sent.status).toBe(400);
  });

  it("a Uint8Array with a custom Symbol.toStringTag is read like any other", async () => {
    const { server } = counted();
    const chunk = encoder.encode(countBodyOf(60));
    Object.defineProperty(chunk, Symbol.toStringTag, { value: "Something" });
    const sent = await send(server, streamed(source([chunk]).stream));
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ data: { count: 1 } });
  });

  it("a Buffer chunk is read like any Uint8Array", async () => {
    const { server } = counted();
    const sent = await send(server, streamed(source([Buffer.from(countBodyOf(60))]).stream));
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ data: { count: 1 } });
  });

  it("empty chunks are skipped, not kept: the body is served and nothing grows with them", async () => {
    const { server } = counted(100);
    const json = encoder.encode(countBodyOf(60));
    const empties = Array.from({ length: 1000 }, () => new Uint8Array(0));
    const sent = await send(server, streamed(source([...empties, json, ...empties]).stream));
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ data: { count: 1 } });
  });
});

describe("the count is in bytes, at the limit", () => {
  // A JSON body ends in ASCII (`}`), so "its last character" is the last one of its content: the
  // name ends in a 2-byte and a 4-byte character, and the chunks split both of them.
  const name = "zoë 🙂";
  const bytes = encoder.encode(helloBody(name));
  const lastE = bytes.indexOf(0xc3);
  const emoji = bytes.indexOf(0xf0);
  const splits = [lastE + 1, emoji + 1, emoji + 3];

  it("a body exactly at the limit is served, whole or split inside its multibyte characters", async () => {
    const { server } = counted(bytes.byteLength);
    for (const chunks of [[bytes], splitAt(bytes, splits)]) {
      const sent = await send(server, streamed(source(chunks).stream));
      expect(sent.status).toBe(200);
      expect(sent.body).toEqual({ data: { hello: `hello ${name}` } });
    }
  });

  it("a body that ends in a multibyte character exactly at the limit is read in full", async () => {
    // Not JSON, so a 400: what matters is that the limit let all of it through.
    const text = encoder.encode('{"query":"{ count }"}é');
    const { server } = counted(text.byteLength);
    const sent = await send(server, streamed(source(splitAt(text, [text.byteLength - 1])).stream));
    expect(sent.status).toBe(400);
    expect(sent.error?.message).toBe("The request body is not valid JSON.");
  });

  it("one byte more gets 413", async () => {
    const { server } = counted(bytes.byteLength - 1);
    const sent = await send(server, streamed(source([bytes]).stream));
    expect(sent.status).toBe(413);
  });

  it("one byte more gets 413 when the extra byte is inside a multibyte character", async () => {
    // The limit ends after the first byte of `é`: counted as characters, the body would fit.
    const text = encoder.encode('{"query":"{ count }"}é');
    const limit = text.byteLength - 1;
    for (const chunks of [[text], splitAt(text, [limit]), splitAt(text, [limit - 1])]) {
      const { server, seen } = counted(limit);
      const sent = await send(server, streamed(source(chunks).stream));
      expect(sent.status).toBe(413);
      expect(seen.params).toBe(0);
    }
  });
});

describe("the option", () => {
  it("defaults to 1 MiB", async () => {
    const { server } = counted();
    const atLimit = await send(
      server,
      streamed(source([encoder.encode(countBodyOf(1 << 20))]).stream),
    );
    expect(atLimit.status).toBe(200);
    expect(atLimit.body).toEqual({ data: { count: 1 } });
    const over = await send(
      server,
      streamed(source([encoder.encode(countBodyOf((1 << 20) + 1))]).stream),
    );
    expect(over.status).toBe(413);
    expect(over.body).toEqual(tooLarge(1 << 20));
  });

  it("Infinity accepts a 5 MB body", async () => {
    const { server } = counted(Number.POSITIVE_INFINITY);
    const sent = await send(
      server,
      streamed(source([encoder.encode(countBodyOf(5_000_000))]).stream, {
        "content-length": "5000000",
      }),
    );
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ data: { count: 1 } });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 2 ** 60])(
    "createServer throws for %s",
    (maxBodyBytes) => {
      expect(() => createServer({ schema: basicSchema(), maxBodyBytes })).toThrow(RangeError);
    },
  );

  it("createServer throws for null: only undefined means the default", () => {
    // @ts-expect-error a JavaScript caller can pass null; it must not silently get the default.
    expect(() => createServer({ schema: basicSchema(), maxBodyBytes: null })).toThrow(RangeError);
  });

  it("accepts Number.MAX_SAFE_INTEGER, and a Content-Length past it is still refused unread", async () => {
    const { server } = counted(Number.MAX_SAFE_INTEGER);
    const body = source([encoder.encode(countBodyOf(60))]);
    const sent = await send(
      server,
      // 2 ** 53 + 1: as a Number it rounds to 2 ** 53, still larger than the limit.
      streamed(body.stream, { "content-length": "9007199254740993" }),
    );
    expect(sent.status).toBe(413);
    expect(body.pulls()).toBe(0);
  });

  it("accepts 1", async () => {
    const server = createServer({ schema: basicSchema(), maxBodyBytes: 1 });
    const sent = await send(server, streamed(source([encoder.encode("{}")]).stream));
    expect(sent.status).toBe(413);
  });
});

/** Reads the socket until the response's JSON body is in, and returns everything read. */
const response = async (socket: Socket): Promise<string> => {
  let text = "";
  socket.setEncoding("utf8");
  for await (const chunk of socket) {
    text += String(chunk);
    if (text.includes("}]}")) {
      return text;
    }
  }
  return text;
};

describe("over a real Node socket (node:http, streamed body)", () => {
  let listening: Listening | undefined;
  const sockets: Array<Socket> = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
    await listening?.close();
    listening = undefined;
  });

  /** Opens a raw connection to the server. */
  const open = async (maxBodyBytes: number): Promise<Socket> => {
    listening = await listen(createServer({ schema: basicSchema(), maxBodyBytes }), {
      streamBody: true,
    });
    const { hostname, port } = new URL(listening.url);
    const socket = connect(Number(port), hostname);
    sockets.push(socket);
    await once(socket, "connect");
    return socket;
  };

  it("a declared upload over the limit gets 413, with nothing of it sent", async () => {
    const socket = await open(1000);
    // Only the headers: a server that waited for the body would never answer.
    socket.write(
      "POST /graphql HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1001\r\n\r\n",
    );
    const text = await response(socket);
    expect(text).toMatch(/^HTTP\/1\.1 413 /);
    expect(text).toContain(JSON.stringify(tooLarge(1000)));
  });

  it("a chunked upload over the limit that never ends gets 413", async () => {
    const socket = await open(4096);
    socket.write(
      "POST /graphql HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
    );
    // More than the limit, and never the closing chunk: only a bounded read can answer.
    const chunk = " ".repeat(1000);
    for (let index = 0; index < 6; index += 1) {
      socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
    }
    const text = await response(socket);
    expect(text).toMatch(/^HTTP\/1\.1 413 /);
    expect(text).toContain(JSON.stringify(tooLarge(4096)));
  });
});
