// Upstream's integration fixtures import "../../../Types.js", which pointed at upstream's
// src/Types.ts. Here the fixtures sit in test/integrationFixtures/<name>/, three levels below
// this package root, so this file forwards to the vendored Types.ts.
export * from "./src/upstream/Types.ts";
