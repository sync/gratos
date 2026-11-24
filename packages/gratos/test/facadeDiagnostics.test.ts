// The TypeScript 7 facade's diagnostics (src/ts/diagnostics.ts), checked against TypeScript
// 5.9.2's own sortAndDeduplicateDiagnostics and formatter on the same inputs.
import {
  createSourceFile as createSourceFile5,
  formatDiagnosticsWithColorAndContext as formatDiagnosticsWithColorAndContext5,
  ScriptTarget as ScriptTarget5,
  sortAndDeduplicateDiagnostics as sortAndDeduplicateDiagnostics5,
} from "typescript-baseline";
import type { Diagnostic as Diagnostic5 } from "typescript-baseline";
import { describe, expect, it } from "vitest";

import { DiagnosticCategory } from "../src/ts/index.ts";
import {
  formatDiagnosticsWithColorAndContext,
  sortAndDeduplicateDiagnostics,
} from "../src/ts/diagnostics.ts";
import type { Diagnostic, DiagnosticMessageChain } from "../src/ts/diagnostics.ts";

// TypeScript 5 compares diagnostic files by `path`; the facade by `fileName`.
const file = { fileName: "/project/a.ts", path: "/project/a.ts", text: "const a = b;\n" };

const diagnostic = (overrides: Partial<Diagnostic> = {}): Diagnostic => ({
  file,
  start: 10,
  length: 1,
  code: 2304,
  category: DiagnosticCategory.Error,
  messageText: "Cannot find name 'b'.",
  ...overrides,
});

const chain = (
  messageText: string,
  next?: Array<DiagnosticMessageChain>,
): DiagnosticMessageChain => ({
  messageText,
  category: DiagnosticCategory.Error,
  code: 2304,
  next,
});

/** The same diagnostics, typed for TypeScript 5, which reads only the fields they have. */
const asTypeScript5 = (diagnostics: ReadonlyArray<Diagnostic>): Array<Diagnostic5> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, quality/no-chained-type-assertions -- see above.
  diagnostics as unknown as Array<Diagnostic5>;

/** The indices in `input` of what TypeScript 5.9.2 and the facade keep, in order. */
const kept = (input: ReadonlyArray<Diagnostic>) => {
  const indices = new Map<object, number>(input.map((entry, index) => [entry, index]));
  const indicesOf = (output: ReadonlyArray<object>): Array<number> =>
    output.map((entry) => indices.get(entry) ?? -1);
  return {
    facade: indicesOf(sortAndDeduplicateDiagnostics(input)),
    typescript5: indicesOf(sortAndDeduplicateDiagnostics5(asTypeScript5(input))),
  };
};

describe("sortAndDeduplicateDiagnostics", () => {
  it("keeps the duplicate that has related information, as TypeScript 5 does", () => {
    const related = diagnostic({
      relatedInformation: [
        diagnostic({ start: 6, code: 2728, messageText: "'b' is declared here." }),
      ],
    });
    for (const input of [
      [diagnostic(), related],
      [related, diagnostic()],
    ]) {
      const { facade, typescript5 } = kept(input);
      expect(facade).toEqual(typescript5);
      expect(facade).toEqual([input.indexOf(related)]);
    }
  });

  it("keeps the duplicate with a message chain, as TypeScript 5 does", () => {
    const chained = diagnostic({
      messageText: chain("Cannot find name 'b'.", [chain("Did you mean 'a'?")]),
    });
    for (const input of [
      [diagnostic(), chained],
      [chained, diagnostic()],
    ]) {
      const { facade, typescript5 } = kept(input);
      expect(facade).toEqual(typescript5);
      expect(facade).toEqual([input.indexOf(chained)]);
    }
  });

  it("keeps diagnostics that differ in place, code or head message", () => {
    const input = [
      diagnostic(),
      diagnostic({ start: 6 }),
      diagnostic({ code: 2552 }),
      diagnostic({ messageText: "Cannot find name 'c'." }),
      diagnostic(),
    ];
    const { facade, typescript5 } = kept(input);
    expect(facade).toEqual(typescript5);
    expect(facade).toHaveLength(4);
  });
});

describe("formatDiagnosticsWithColorAndContext", () => {
  it("keeps the file name's spelling when the host canonicalizes names, as TypeScript 5 does", () => {
    const sourceFile = createSourceFile5(
      "/Work/Project/Src/Order.ts",
      "const a = b;\n",
      ScriptTarget5.Latest,
    );
    const input = [diagnostic({ file: sourceFile })];
    for (const currentDirectory of ["/work/PROJECT", "/WORK/project/src/models", "/elsewhere"]) {
      const host = {
        getCurrentDirectory: () => currentDirectory,
        getCanonicalFileName: (fileName: string) => fileName.toLowerCase(),
        getNewLine: () => "\n",
      };
      const facade = formatDiagnosticsWithColorAndContext(input, host);
      const typescript5 = formatDiagnosticsWithColorAndContext5(asTypeScript5(input), host);
      expect(facade).toBe(typescript5);
    }
    expect(
      formatDiagnosticsWithColorAndContext(input, {
        getCurrentDirectory: () => "/work/PROJECT",
        getCanonicalFileName: (fileName) => fileName.toLowerCase(),
        getNewLine: () => "\n",
      }),
    ).toContain("Src/Order.ts");
  });
});
