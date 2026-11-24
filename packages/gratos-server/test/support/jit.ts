// jit() wrapped to record, per executed request, which executor ran: "jit" (the compiled query),
// "next" (jit delegated during warm-up or after declining at compile time) or "declined" (jit
// returned no executor).
import { jit } from "../../src/index.ts";
import type { JitOptions, Plugin } from "../../src/index.ts";

export type JitRun = "jit" | "next" | "declined";

export const watchedJit = (options: JitOptions) => {
  const ran: Array<JitRun> = [];
  const inner = jit(options);
  const plugin: Plugin = {
    ...inner,
    onExecute: (input, args) => {
      const executor = inner.onExecute?.(input, args);
      if (executor === undefined) {
        ran.push("declined");
        return undefined;
      }
      return (next) => {
        let delegated = false;
        const result = executor(() => {
          delegated = true;
          return next();
        });
        ran.push(delegated ? "next" : "jit");
        return result;
      };
    },
  };
  return { plugin, ran };
};
