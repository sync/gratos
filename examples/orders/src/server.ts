// The orders server on NodeHttpServer: `pnpm start` (production) or `pnpm dev` (live rebuild).
//
// `pnpm dev` runs this file under `GRATS_DEV=1 node --watch-path=src/models
// --watch-path=src/services`: GRATS_DEV is explicit because Node removes --watch and --watch-path
// from the child's process.execArgv. In dev, the boot step from @dblechoc/gratos/dev, imported
// only then, regenerates src/generated/ from the models before the schema module is imported;
// when the models do not build, every GraphQL request answers 500 GRATS_ERROR with the
// diagnostics until the next good save restarts the process. A production start imports the
// committed src/generated/schema.ts and never loads the compiler or TypeScript.
import { createServer as createHttpServer } from "node:http";

import type { GratsDevError } from "@dblechoc/gratos/dev";
import { effectRouteLayer } from "@dblechoc/gratos-server/effect";
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, Layer, Result } from "effect";
import type { FileSystem } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { makeServer } from "./graphql.ts";
import type { Services } from "./graphql.ts";
import { Bus } from "./services/Bus.ts";
import { FakeApi } from "./services/FakeApi.ts";

const dev = process.env["GRATS_DEV"] === "1";

/** Imported, never statically: in dev it exists only once the boot step has written it. */
const loadSchemaModule = () => import("./generated/schema.ts");

/** The generated schema module, or (in dev) why the models do not build. */
const schemaModule: Effect.Effect<
  Result.Result<Awaited<ReturnType<typeof loadSchemaModule>>, GratsDevError>,
  never,
  FileSystem.FileSystem
> = dev
  ? Effect.promise(() => import("@dblechoc/gratos/dev")).pipe(
      Effect.flatMap((gratos) =>
        gratos.devSchema({
          tsconfig: new URL("tsconfig.json", import.meta.url),
          load: loadSchemaModule,
        }),
      ),
      Effect.result,
    )
  : Effect.map(Effect.promise(loadSchemaModule), Result.succeed);

/** POST /graphql (and the core's answers to other methods), or GRATS_ERROR for every request. */
const graphqlLayer = Layer.unwrap(
  Effect.gen(function* () {
    const loaded = yield* schemaModule;
    if (Result.isFailure(loaded)) {
      const error = loaded.failure;
      return HttpRouter.add(
        "*",
        "/graphql",
        Effect.sync(() => HttpServerResponse.fromWeb(error.response())),
      );
    }
    const services = yield* Effect.context<Services>();
    return effectRouteLayer(makeServer(loaded.success.getSchema(), services));
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

HttpRouter.serve(graphqlLayer).pipe(
  Layer.provide([FakeApi.layer, Bus.layer, NodeServices.layer]),
  Layer.provide(httpServerLayer),
  Layer.launch,
  NodeRuntime.runMain,
);
