// TypeScript 5's createPrinter().printList on top of TypeScript 7's emitter.printNode, and the
// minimal createSourceFile the engine needs (DiagnosticError for GraphQL sources, TSAstBuilder
// as the printer's context file): a file name, its text and a line map.
import { join } from "node:path";

import { Data } from "effect";
import {
  computeLineStarts,
  LanguageVariant,
  ScriptKind,
  SyntaxKind,
} from "typescript/unstable/ast";
import type { Node } from "typescript/unstable/ast";
import type { Project } from "typescript/unstable/sync";

import { anyOpenProject } from "./program.ts";
import { defaultSession, openProject, openSessionList } from "./session.ts";

/** TypeScript 7's printer failed on a node the codegen built: a bug, not a user error. */
export class PrintNodeDefect extends Data.TaggedError("PrintNodeDefect")<{
  readonly kind: string;
  readonly cause: unknown;
}> {}

/**
 * printNode is an RPC on an open project; reuse one on any open session (a default one, or one
 * the Effect shell scoped to a generate() call), or open an empty one.
 */
const printingProject = (): Project => {
  const open = anyOpenProject(openSessionList());
  if (open !== undefined) {
    return open;
  }
  const session = defaultSession(false);
  const configPath = join(process.cwd(), `__gratos_printer_${process.pid}__.tsconfig.json`);
  session.virtualFiles.set(configPath, JSON.stringify({ compilerOptions: {}, files: [] }));
  return openProject(session, configPath);
};

export const printNode = (node: Node): string => {
  try {
    return printingProject().emitter.printNode(node);
  } catch (error) {
    throw new PrintNodeDefect({ kind: SyntaxKind[node.kind] ?? `${node.kind}`, cause: error });
  }
};

export interface Printer {
  printList(format: number, list: ReadonlyArray<Node>, sourceFile: unknown): string;
  printNode(hint: number, node: Node, sourceFile: unknown): string;
}

/**
 * TypeScript 5's printer, for the one format the engine uses: ListFormat.MultiLine, each node on
 * its own line, with a final newline. Output uses "\n" line endings, as the engine asks for.
 */
export const createPrinter = (_options?: unknown): Printer => ({
  printList: (_format, list) =>
    list.length === 0 ? "" : `${list.map((node) => printNode(node)).join("\n")}\n`,
  printNode: (_hint, node) => printNode(node),
});

export interface LineMapSourceFile {
  readonly kind: SyntaxKind.SourceFile;
  readonly fileName: string;
  readonly text: string;
  readonly languageVariant: LanguageVariant;
  readonly scriptKind: ScriptKind;
  getLineStarts(): ReadonlyArray<number>;
  getLineAndCharacterOfPosition(position: number): { line: number; character: number };
  getPositionOfLineAndCharacter(line: number, character: number): number;
}

/** A source file with no AST: what diagnostics and the printer read from TypeScript 5's. */
export const createSourceFile = (
  fileName: string,
  text: string,
  _languageVersion?: unknown,
  _setParentNodes?: boolean,
  scriptKind?: ScriptKind,
): LineMapSourceFile => {
  let lineStarts: ReadonlyArray<number> | undefined;
  const getLineStarts = (): ReadonlyArray<number> => {
    lineStarts ??= computeLineStarts(text);
    return lineStarts;
  };
  return {
    kind: SyntaxKind.SourceFile,
    fileName,
    text,
    languageVariant: LanguageVariant.Standard,
    scriptKind: scriptKind ?? ScriptKind.TS,
    getLineStarts,
    getLineAndCharacterOfPosition: (position) => {
      const starts = getLineStarts();
      let line = 0;
      while (line + 1 < starts.length && (starts[line + 1] ?? 0) <= position) {
        line++;
      }
      return { line, character: position - (starts[line] ?? 0) };
    },
    getPositionOfLineAndCharacter: (line, character) =>
      (getLineStarts()[line] ?? text.length) + character,
  };
};
