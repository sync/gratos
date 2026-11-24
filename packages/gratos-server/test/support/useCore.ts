// Loads the package entry under plain Node and serves one request through every plugin, so every
// module the core and its plugins reach (eagerly or lazily) is resolved.
import { buildSchema } from "graphql";

import {
  apq,
  createServer,
  jit,
  maskErrors,
  maxDepth,
  readOnly,
  reportErrors,
  serverTiming,
} from "../../src/index.ts";

const schema = buildSchema("type Query { count: Int }");
const server = createServer({
  schema,
  rootValue: { count: 1 },
  plugins: [
    apq(),
    reportErrors(() => {}),
    maskErrors(),
    serverTiming(),
    maxDepth(5),
    readOnly(),
    jit({ after: 1 }),
  ],
});
const response = await server.handle(
  new Request("http://localhost/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ count }" }),
  }),
);
process.stdout.write(await response.text());
