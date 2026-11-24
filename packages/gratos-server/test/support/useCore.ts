// Loads the package entry under plain Node and serves one successful query through every plugin.
// The trace covers every module the entry imports statically, plus any module this one request
// loads lazily; a module that only another path would load (an error, an APQ hit, a jit decline…)
// is not covered.
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
} from "@dblechoc/gratos-server";

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
