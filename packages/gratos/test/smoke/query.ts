// Run by test/cli.test.ts under plain Node, after the CLI generated ./schema.ts: imports the
// generated schema, executes a query and prints the result as JSON.
import { Predicate } from "effect";
import { graphql } from "graphql";

import { getSchema } from "./schema.ts";

const schema = getSchema({
  scalars: {
    DateTime: {
      serialize: (value) => (Predicate.isDate(value) ? value.toISOString() : String(value)),
    },
  },
});
const result = await graphql({
  schema,
  source: "{ orders { id quantity customer { id name joinedAt } } }",
});
process.stdout.write(JSON.stringify(result));
