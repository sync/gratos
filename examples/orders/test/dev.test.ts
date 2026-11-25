// The dev loop (docs/plan.html M6 "Done when"), on the real `pnpm dev` process: node
// --watch-path over a copy of the app. A save restarts the server once, the boot step
// regenerates the schema, broken models answer GRATS_ERROR until the next good save, and each
// restart starts the APQ cache and open subscriptions over. Save-to-first-good-response is
// bounded at 2 s locally and 3 s (+50%) when CI is set.
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { copyApp, devCommand, post, start, until } from "./support/app.ts";
import type { AppCopy, Answer, Payload, Running } from "./support/app.ts";

const BUDGET_MS = process.env["CI"] === undefined ? 2000 : 3000;
/** Bounds for waits that are not measured against the budget (a first boot, a failure). */
const BOOT_MS = 15_000;

const MODEL = "src/models/Order.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const startDev = async (): Promise<{ readonly app: AppCopy; readonly dev: Running }> => {
  const app = copyApp();
  cleanups.push(app.remove);
  const { env, args } = devCommand();
  const dev = await start(app.dir, args, env);
  cleanups.push(dev.stop);
  return { app, dev };
};

const ORDER = { query: '{ order(id: "o-1") { id status } }' };
const LABEL = { query: '{ order(id: "o-1") { label } }' };

const dataOf = (answer: Answer | undefined, expected: unknown): Answer | undefined =>
  answer !== undefined &&
  answer.status === 200 &&
  JSON.stringify(answer.body) === JSON.stringify({ data: expected })
    ? answer
    : undefined;

/** The first good answer to `payload`, polled; fails with the process output after `timeoutMs`. */
const firstGood = (dev: Running, payload: Payload, expected: unknown, timeoutMs: number) =>
  until(async () => dataOf(await post(dev.url, payload), expected), {
    timeoutMs,
    message: `no good answer to ${JSON.stringify(payload)}`,
    app: dev,
  });

/** Writes `file` with `edit` applied, and returns the time of the save. */
const save = (app: AppCopy, file: string, edit: (source: string) => string): number => {
  const before = app.read(file);
  const after = edit(before);
  expect(after).not.toBe(before);
  const savedAt = performance.now();
  writeFileSync(app.path(file), after);
  return savedAt;
};

const LABEL_FIELD = `
  /** @gqlField */
  label(): string {
    return \`\${this.id}:\${this.status}\`;
  }

  constructor(row: OrderRow) {`;

const addLabel = (source: string) =>
  source.replace("\n  constructor(row: OrderRow) {", LABEL_FIELD);

const timings: Array<string> = [];

describe("pnpm dev", () => {
  it("edits a model and sees the new field after one restart, within the budget", async () => {
    const { app, dev } = await startDev();
    await firstGood(dev, ORDER, { order: { id: "o-1", status: "open" } }, BOOT_MS);
    expect(dev.output()).toContain("Gratos: the schema is up to date");
    expect(dev.restarts()).toBe(0);

    const savedAt = save(app, MODEL, addLabel);
    await firstGood(dev, LABEL, { order: { label: "o-1:open" } }, BOOT_MS);
    const elapsed = performance.now() - savedAt;
    timings.push(`edit → new field: ${Math.round(elapsed)} ms`);
    expect(elapsed).toBeLessThanOrEqual(BUDGET_MS);

    // The boot step wrote the generated files, which are not watched: no second restart.
    expect(app.read("src/generated/schema.graphql")).toContain("label: String");
    await sleep(500);
    expect(dev.restarts()).toBe(1);
    expect(dev.output()).toContain("Gratos: wrote generated/schema.graphql, generated/schema.ts");
  });

  it("breaks the model, answers GRATS_ERROR with the diagnostics, and recovers on the fix", async () => {
    const { app, dev } = await startDev();
    await firstGood(dev, ORDER, { order: { id: "o-1", status: "open" } }, BOOT_MS);

    // A type Grats cannot map to GraphQL.
    save(app, MODEL, (source) =>
      source.replace("  status: string;", "  status: Map<string, number>;"),
    );
    const broken = await until(
      async () => {
        const answer = await post(dev.url, ORDER);
        return answer?.status === 500 ? answer : undefined;
      },
      { timeoutMs: BOOT_MS, message: "no GRATS_ERROR", app: dev },
    );
    expect(broken.body).toEqual({
      errors: [
        {
          message: expect.stringContaining(
            "Gratos could not build the schema: Unable to resolve type reference.",
          ),
          extensions: {
            code: "GRATS_ERROR",
            diagnostics: [
              {
                message: expect.stringContaining("Unable to resolve type reference."),
                file: "src/models/Order.ts",
                line: 14,
                column: 11,
              },
            ],
          },
        },
      ],
    });
    // Every request, whatever its method, until the next good save.
    const get = await fetch(`${dev.url}?query=${encodeURIComponent("{ __typename }")}`);
    expect(get.status).toBe(500);
    expect(get.headers.get("content-type")).toBe(
      "application/graphql-response+json; charset=utf-8",
    );
    expect(await get.json()).toMatchObject({ errors: [{ extensions: { code: "GRATS_ERROR" } }] });
    expect(dev.output()).toContain(
      "every request answers 500 GRATS_ERROR until the next good save",
    );

    // A syntax error: TypeScript's own diagnostic, through the same answer.
    save(app, MODEL, (source) =>
      source.replace("  status: Map<string, number>;", "  status: string = ;"),
    );
    await until(
      async () => {
        const answer = await post(dev.url, ORDER);
        return answer?.status === 500 && JSON.stringify(answer.body).includes("Expression expected")
          ? answer
          : undefined;
      },
      { timeoutMs: BOOT_MS, message: "no GRATS_ERROR for the syntax error", app: dev },
    );

    const fixedAt = save(app, MODEL, (source) =>
      source.replace("  status: string = ;", "  status: string;"),
    );
    await firstGood(dev, ORDER, { order: { id: "o-1", status: "open" } }, BOOT_MS);
    const elapsed = performance.now() - fixedAt;
    timings.push(`fix → recovered: ${Math.round(elapsed)} ms`);
    expect(elapsed).toBeLessThanOrEqual(BUDGET_MS);
    expect(dev.restarts()).toBe(3);
  });

  it("starts the APQ cache and open subscriptions over on each save", async () => {
    const { app, dev } = await startDev();
    await firstGood(dev, ORDER, { order: { id: "o-1", status: "open" } }, BOOT_MS);

    // Register the query under its hash, then answer the hash alone from the cache.
    const query = ORDER.query;
    const sha256Hash = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(query)),
    ).toString("hex");
    const persisted = { extensions: { persistedQuery: { version: 1, sha256Hash } } };
    expect(
      dataOf(await post(dev.url, { query, ...persisted }), {
        order: { id: "o-1", status: "open" },
      }),
    ).toBeDefined();
    expect(
      dataOf(await post(dev.url, persisted), { order: { id: "o-1", status: "open" } }),
    ).toBeDefined();

    // An open subscription, which has received an event (the core answers with the first one).
    const subscription = fetch(dev.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ query: 'subscription { orderChanged(id: "o-2") { status } }' }),
      signal: AbortSignal.timeout(BOOT_MS),
    });
    const cancelled = { cancelOrder: { status: "cancelled" } };
    const cancel = { query: 'mutation { cancelOrder(id: "o-2") { status } }' };
    // Cancel until the subscription has started (its setup runs after the request is sent).
    const opened = await until(
      async () => {
        expect(dataOf(await post(dev.url, cancel), cancelled)).toBeDefined();
        return Promise.race([subscription, sleep(50, undefined)]);
      },
      { timeoutMs: BOOT_MS, message: "the subscription never answered", app: dev },
    );
    expect(opened.status).toBe(200);
    expect(opened.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = opened.body?.getReader();
    if (reader === undefined) {
      throw new Error("the subscription has no body");
    }
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('"status":"cancelled"');
    const ended = (async () => {
      try {
        while (!(await reader.read()).done) {
          // Drain until the old process drops the connection.
        }
      } catch {
        // A dropped connection.
      }
      return performance.now();
    })();

    // A save that changes no schema: the restart alone starts everything over.
    const savedAt = save(app, MODEL, (source) => `${source}\n// saved\n`);
    // The subscription is dropped promptly (not after the 20 s graceful-shutdown default), and
    // the new process answers within the budget although a subscription was open. The old
    // process answers this query too until it stops: wait for the new one to listen.
    await until(async () => (dev.boots() === 2 ? true : undefined), {
      timeoutMs: BOOT_MS,
      message: "the server never restarted",
      app: dev,
    });
    await firstGood(dev, ORDER, { order: { id: "o-1", status: "open" } }, BOOT_MS);
    const elapsed = performance.now() - savedAt;
    timings.push(`save with an open subscription → answered: ${Math.round(elapsed)} ms`);
    expect(elapsed).toBeLessThanOrEqual(BUDGET_MS);
    const endedAt = await Promise.race([ended, sleep(1000, undefined)]);
    expect(endedAt).toBeDefined();
    expect(dev.output()).toContain("Gratos: the schema is up to date");

    // The new process has an empty APQ cache: the hash alone is not found.
    expect(await post(dev.url, persisted)).toMatchObject({
      body: { errors: [{ extensions: { code: "PERSISTED_QUERY_NOT_FOUND" } }] },
    });
    // The new process starts from the fake API's initial rows.
    expect(
      dataOf(await post(dev.url, { query: '{ order(id: "o-2") { status } }' }), {
        order: { status: "shipped" },
      }),
    ).toBeDefined();
    expect(dev.restarts()).toBe(1);
  });

  it("reports its timings", () => {
    // oxlint-disable-next-line no-console
    console.log(`dev-loop timings (budget ${BUDGET_MS} ms):\n  ${timings.join("\n  ")}`);
    expect(timings.length).toBeGreaterThan(0);
  });
});
