// A `node --import` preload that records the URL of every module the process resolves (ESM
// imports and CommonJS requires) and writes them as JSON to $GRATOS_RECORD_MODULES on exit.
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";

const urls = new Set<string>();
registerHooks({
  resolve: (specifier, context, nextResolve) => {
    const result = nextResolve(specifier, context);
    urls.add(result.url);
    return result;
  },
});
process.on("exit", () => {
  const output = process.env["GRATOS_RECORD_MODULES"];
  if (output !== undefined) {
    writeFileSync(output, JSON.stringify([...urls]));
  }
});
