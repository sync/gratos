// The TypeScript 7 facade's JSDoc lookup (src/ts/jsdoc.ts), checked against TypeScript 5.9.2's
// getJSDocTags on the same sources.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSourceFile as createSourceFile5,
  forEachChild as forEachChild5,
  getJSDocTags as getJSDocTags5,
  ScriptKind as ScriptKind5,
  ScriptTarget as ScriptTarget5,
  SyntaxKind as SyntaxKind5,
} from "typescript-baseline";
import type { Node as Node5 } from "typescript-baseline";
import { SyntaxKind } from "typescript/unstable/ast";
import type { Node } from "typescript/unstable/ast";
import { afterAll, describe, expect, it } from "vitest";

import { getJSDocTags } from "../src/ts/jsdoc.ts";
import { createProgram } from "../src/ts/program.ts";
import { closeDefaultSessions } from "../src/ts/session.ts";

const directory = mkdtempSync(join(tmpdir(), "gratos-jsdoc-"));

afterAll(() => {
  closeDefaultSessions();
  rmSync(directory, { recursive: true, force: true });
});

// Function expressions defaulted in an assignment: TypeScript 5 gives them the statement's JSDoc
// only when the assignment declares something (a property, or in JS files also `this.x`,
// `exports.x` or a prototype member), never for a bare identifier.
const DEFAULTED_ASSIGNMENTS = `
/** @example identifier */
x = x || function () {};
/** @example property */
o.p = o.p || function () {};
/** @example element */
o["q"] = o["q"] ?? function () {};
/** @example dynamic */
o[k] = o[k] || function () {};
/** @example this */
this.t = this.t || function () {};
/** @example exports */
exports.e = exports.e || function () {};
/** @example moduleExports */
module.exports = module.exports || function () {};
/** @example prototype */
C.prototype.m = C.prototype.m || function () {};
/** @example compound */
o.c ||= o.c || function () {};
/** @example initializer */
const v = v0 || function () {};
`;

/** The tag names of every function expression, in source order. */
const tagNamesOf = (root: Node): Array<Array<string>> => {
  const result: Array<Array<string>> = [];
  const visit = (node: Node): void => {
    if (node.kind === SyntaxKind.FunctionExpression) {
      result.push(getJSDocTags(node).map((tag) => tag.tagName.text));
    }
    node.forEachChild(visit);
  };
  visit(root);
  return result;
};

const tagNamesOf5 = (root: Node5): Array<Array<string>> => {
  const result: Array<Array<string>> = [];
  const visit = (node: Node5): void => {
    if (node.kind === SyntaxKind5.FunctionExpression) {
      result.push(getJSDocTags5(node).map((tag) => tag.tagName.text));
    }
    forEachChild5(node, visit);
  };
  visit(root);
  return result;
};

describe("getJSDocTags", () => {
  const files = {
    "defaulted.ts": `declare let x: any, o: any, k: string, v0: any, C: any, exports: any, module: any;\n${DEFAULTED_ASSIGNMENTS}`,
    "defaulted.js": DEFAULTED_ASSIGNMENTS,
  };
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(directory, name), text);
  }
  const program = createProgram(
    Object.keys(files).map((name) => join(directory, name)),
    { allowJs: true, noEmit: true },
  );

  for (const [name, text] of Object.entries(files)) {
    it(`gives a defaulted function the statement's tags only for declarations (${name})`, () => {
      const sourceFile = program.getSourceFile(join(directory, name));
      if (sourceFile === undefined) {
        throw new Error(`no source file for ${name}`);
      }
      const facade = tagNamesOf(sourceFile);
      const typescript5 = tagNamesOf5(
        createSourceFile5(
          join(directory, name),
          text,
          ScriptTarget5.Latest,
          true,
          name.endsWith(".js") ? ScriptKind5.JS : ScriptKind5.TS,
        ),
      );
      expect(facade).toEqual(typescript5);
      // The bare identifier never takes the tag; a property assignment always does.
      expect(facade[0]).toEqual([]);
      expect(facade[1]).toEqual(["example"]);
    });
  }
});
