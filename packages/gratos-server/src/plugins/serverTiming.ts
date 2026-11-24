// serverTiming(): a Server-Timing header with each reported phase (parse, validate, jit…) and the
// total time since handle() received the request. The reference for the body rule: it replaces
// the Response but reuses `res.body`, so body wrappers in other plugins keep working whatever the
// plugin order.
import { startOf } from "../core/requestState.ts";
import type { Phase, Plugin } from "../core/types.ts";

const ms = (value: number): string => value.toFixed(3).replace(/\.?0+$/, "");

export const serverTiming = (): Plugin => {
  const phases = new WeakMap<Request, Array<Phase>>();
  return {
    name: "serverTiming",
    onPhase: (phase, request) => {
      const list = phases.get(request);
      if (list === undefined) {
        phases.set(request, [phase]);
      } else {
        list.push(phase);
      }
    },
    onResponse: (response, request) => {
      const entries = (phases.get(request) ?? []).map(
        ({ name, start, end }) => `${name};dur=${ms(end - start)}`,
      );
      const start = startOf(request);
      if (start !== undefined) {
        entries.push(`total;dur=${ms(performance.now() - start)}`);
      }
      if (entries.length === 0) {
        return undefined;
      }
      const headers = new Headers(response.headers);
      headers.append("server-timing", entries.join(", "));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
};
