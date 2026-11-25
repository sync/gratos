// The orders server on NodeHttpServer: `pnpm start` (production) or `pnpm dev` (live rebuild).
//
// `pnpm dev` runs this file under `GRATS_DEV=1 node --watch-path=src/models
// --watch-path=src/services`: GRATS_DEV is explicit because Node removes --watch and --watch-path
// from the child's process.execArgv. In dev, the boot step from @dblechoc/gratos/dev, imported
// only then, regenerates src/generated/ from the models, then loads the app: the generated schema
// module and the wiring in graphql.ts (which imports the services). When either does not build or
// load, every request, on any path, answers 500 GRATS_ERROR with the diagnostics until the next
// good save restarts the process. This file therefore imports nothing from the watched folders.
// A production start loads the same two modules and never loads the compiler or TypeScript.
import { createServer as createHttpServer } from "node:http";

import type { GratsDevError } from "@dblechoc/gratos/dev";
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, Layer, Result } from "effect";
import type { FileSystem } from "effect";
import { HttpServer, HttpServerResponse } from "effect/http";

const dev = process.env["GRATS_DEV"] === "1";

/**
 * The app: the generated schema served by the wiring in graphql.ts. Imported, never
 * statically: in dev the schema exists only once the boot step has written it, and a module that
 * fails to load must fail inside the boot step's error boundary, not before it.
 */
const loadApp = async () => {
  const [schema, app] = await Promise.all([
    import("./generated/schema.ts"),
    import("./graphql.ts"),
  ]);
  return app.appLayer(schema.getSchema());
};

type AppLayer = Awaited<ReturnType<typeof loadApp>>;

/** The app, or (in dev) why the models or the app do not build or load. */
const app: Effect.Effect<Result.Result<AppLayer, GratsDevError>, never, FileSystem.FileSystem> = dev
  ? Effect.promise(() => import("@dblechoc/gratos/dev")).pipe(
      Effect.flatMap((gratos) =>
        gratos.devSchema({ tsconfig: new URL("tsconfig.json", import.meta.url), load: loadApp }),
      ),
      Effect.result,
    )
  : Effect.map(Effect.promise(loadApp), Result.succeed);

/**
 * The app, or GRATS_ERROR for every request: served by the HTTP server itself, with no router, so
 * no path (not even one the router could not decode, such as `/%FF`) misses it.
 */
const appLayer = Layer.unwrap(
  Effect.map(app, (loaded) => {
    if (Result.isSuccess(loaded)) {
      return loaded.success;
    }
    const error = loaded.failure;
    return HttpServer.serve(Effect.sync(() => HttpServerResponse.fromWeb(error.response())));
  }),
);

const httpServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(4000));
    const host = yield* Config.String("HOST").pipe(Config.withDefault("127.0.0.1"));
    return NodeHttpServer.layer(() => createHttpServer(), {
      port,
      host,
      // A dev restart waits for this process to exit: open subscriptions are dropped at once
      // (clients reconnect to the new process) instead of after the 20 s production default.
      gracefulShutdownTimeout: dev ? "100 millis" : undefined,
    });
  }),
);

appLayer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(httpServerLayer),
  Layer.launch,
  NodeRuntime.runMain,
);
