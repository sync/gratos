// readOnly(): refuses every mutation with a 403 before it starts (a read-only replica, a
// maintenance window). It reads the operation the core resolved: onExecute({ operation }).
import { gqlError } from "../core/errors.ts";
import type { Plugin } from "../core/types.ts";

export const readOnly = (): Plugin => ({
  name: "readOnly",
  onExecute: ({ operation }) => {
    if (operation.operation === "mutation") {
      throw gqlError("This server is read-only.", 403, { code: "READ_ONLY" });
    }
    return undefined;
  },
});
