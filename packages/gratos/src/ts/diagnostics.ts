// TS5-shaped diagnostics on top of TypeScript 7.
//
// The engine builds and formats diagnostics in TypeScript 5's shape ({ file, start, length,
// messageText }), and 211 fixture snapshots depend on TypeScript 5's formatter output. This
// module converts TypeScript 7 API diagnostics into that shape and ports
// formatDiagnosticsWithColorAndContext from TypeScript 5.9.2 (src/compiler/program.ts) byte for
// byte. It needs only `fileName` and `text` from a source file, so it formats diagnostics on
// TypeScript 7 source files and on the line-map shims of createSourceFile alike.
import { isAbsolute, relative, sep } from "node:path";

import { computeLineStarts } from "typescript/unstable/ast";
import { DiagnosticCategory } from "typescript/unstable/sync";
import type { Diagnostic as Ts7Diagnostic } from "typescript/unstable/sync";

/** The parts of a source file that diagnostics read. */
export interface DiagnosticFile {
  readonly fileName: string;
  readonly text: string;
}

export interface DiagnosticMessageChain {
  readonly messageText: string;
  readonly category: DiagnosticCategory;
  readonly code: number;
  readonly next?: ReadonlyArray<DiagnosticMessageChain> | undefined;
}

export interface DiagnosticRelatedInformation {
  readonly category: DiagnosticCategory;
  readonly code: number;
  readonly file: DiagnosticFile | undefined;
  readonly start: number | undefined;
  readonly length: number | undefined;
  readonly messageText: string | DiagnosticMessageChain;
}

export interface Diagnostic extends DiagnosticRelatedInformation {
  readonly source?: string | undefined;
  readonly relatedInformation?: ReadonlyArray<DiagnosticRelatedInformation> | undefined;
}

export interface FormatDiagnosticsHost {
  getCurrentDirectory(): string;
  getCanonicalFileName(fileName: string): string;
  getNewLine(): string;
}

const toMessageChain = (diagnostic: Ts7Diagnostic): DiagnosticMessageChain => ({
  messageText: diagnostic.text,
  category: diagnostic.category,
  code: diagnostic.code,
  next:
    diagnostic.messageChain !== undefined && diagnostic.messageChain.length > 0
      ? diagnostic.messageChain.map(toMessageChain)
      : undefined,
});

const messageTextOf = (diagnostic: Ts7Diagnostic): string | DiagnosticMessageChain =>
  diagnostic.messageChain !== undefined && diagnostic.messageChain.length > 0
    ? toMessageChain(diagnostic)
    : diagnostic.text;

/** Converts a TypeScript 7 API diagnostic to TypeScript 5's shape. */
export const fromTs7Diagnostic = (
  diagnostic: Ts7Diagnostic,
  fileOf: (fileName: string) => DiagnosticFile | undefined,
): Diagnostic => {
  const file = diagnostic.fileName === undefined ? undefined : fileOf(diagnostic.fileName);
  const related = diagnostic.relatedInformation;
  return {
    file,
    start: file === undefined ? undefined : diagnostic.pos,
    length: file === undefined ? undefined : diagnostic.end - diagnostic.pos,
    messageText: messageTextOf(diagnostic),
    category: diagnostic.category,
    code: diagnostic.code,
    relatedInformation:
      related !== undefined && related.length > 0
        ? related.map((info) => fromTs7Diagnostic(info, fileOf))
        : undefined,
  };
};

// ---- Sorting, as TypeScript 5's sortAndDeduplicateDiagnostics ----

const compareValues = (a: number | string | undefined, b: number | string | undefined): number => {
  if (a === b) {
    return 0;
  }
  if (a === undefined) {
    return -1;
  }
  if (b === undefined) {
    return 1;
  }
  return a < b ? -1 : 1;
};

const flattenForCompare = (text: string | DiagnosticMessageChain): string =>
  typeof text === "string" ? text : flattenDiagnosticMessageText(text, "\n");

const compareDiagnostics = (a: Diagnostic, b: Diagnostic): number =>
  compareValues(a.file?.fileName, b.file?.fileName) ||
  compareValues(a.start, b.start) ||
  compareValues(a.length, b.length) ||
  compareValues(a.code, b.code) ||
  compareValues(flattenForCompare(a.messageText), flattenForCompare(b.messageText));

export const sortAndDeduplicateDiagnostics = (
  diagnostics: ReadonlyArray<Diagnostic>,
): Array<Diagnostic> => {
  const sorted = diagnostics.toSorted(compareDiagnostics);
  return sorted.filter(
    (diagnostic, index) =>
      index === 0 || compareDiagnostics(sorted[index - 1] ?? diagnostic, diagnostic) !== 0,
  );
};

// ---- formatDiagnosticsWithColorAndContext, ported from TypeScript 5.9.2 ----

const RED = "\u001b[91m";
const YELLOW = "\u001b[93m";
const BLUE = "\u001b[94m";
const CYAN = "\u001b[96m";
const GREY = "\u001b[90m";
const GUTTER_STYLE = "\u001b[7m";
const RESET = "\u001b[0m";
const GUTTER_SEPARATOR = " ";
const ELLIPSIS = "...";
const HALF_INDENT = "  ";
const INDENT = "    ";
/** Diagnostics.File_appears_to_be_binary.code */
const FILE_APPEARS_TO_BE_BINARY = 1490;

const lineStartsCache = new WeakMap<DiagnosticFile, ReadonlyArray<number>>();
const lineStartsOf = (file: DiagnosticFile): ReadonlyArray<number> => {
  const cached = lineStartsCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const lineStarts = computeLineStarts(file.text);
  lineStartsCache.set(file, lineStarts);
  return lineStarts;
};

interface LineAndCharacter {
  readonly line: number;
  readonly character: number;
}

const lineAndCharacterOf = (file: DiagnosticFile, position: number): LineAndCharacter => {
  const lineStarts = lineStartsOf(file);
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = low + ((high - low) >> 1);
    const start = lineStarts[middle] ?? 0;
    if (start === position) {
      return { line: middle, character: 0 };
    }
    if (start < position) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const line = low - 1;
  return { line, character: position - (lineStarts[line] ?? 0) };
};

const positionOfLine = (file: DiagnosticFile, line: number): number =>
  lineStartsOf(file)[line] ?? file.text.length;

const formatColorAndReset = (text: string, formatStyle: string): string =>
  formatStyle + text + RESET;

const categoryFormat = (category: DiagnosticCategory): string => {
  switch (category) {
    case DiagnosticCategory.Error:
      return RED;
    case DiagnosticCategory.Warning:
      return YELLOW;
    case DiagnosticCategory.Suggestion:
      throw new Error("Should never get an Info diagnostic on the command line.");
    case DiagnosticCategory.Message:
      return BLUE;
  }
};

const categoryName = (category: DiagnosticCategory): string => {
  switch (category) {
    case DiagnosticCategory.Error:
      return "error";
    case DiagnosticCategory.Warning:
      return "warning";
    case DiagnosticCategory.Suggestion:
      return "suggestion";
    case DiagnosticCategory.Message:
      return "message";
  }
};

const toRelativePath = (fileName: string, host: FormatDiagnosticsHost): string => {
  if (!isAbsolute(fileName)) {
    return fileName;
  }
  const relativePath = relative(
    host.getCanonicalFileName(host.getCurrentDirectory()),
    host.getCanonicalFileName(fileName),
  );
  return sep === "/" ? relativePath : relativePath.replaceAll(sep, "/");
};

const formatLocation = (
  file: DiagnosticFile,
  start: number,
  host: FormatDiagnosticsHost,
): string => {
  const { line, character } = lineAndCharacterOf(file, start);
  return (
    formatColorAndReset(toRelativePath(file.fileName, host), CYAN) +
    ":" +
    formatColorAndReset(`${line + 1}`, YELLOW) +
    ":" +
    formatColorAndReset(`${character + 1}`, YELLOW)
  );
};

const formatCodeSpan = (
  file: DiagnosticFile,
  start: number,
  length: number,
  indent: string,
  squiggleColor: string,
  host: FormatDiagnosticsHost,
): string => {
  const { line: firstLine, character: firstLineChar } = lineAndCharacterOf(file, start);
  const { line: lastLine, character: lastLineChar } = lineAndCharacterOf(file, start + length);
  const lastLineInFile = lineAndCharacterOf(file, file.text.length).line;
  const hasMoreThanFiveLines = lastLine - firstLine >= 4;
  let gutterWidth = `${lastLine + 1}`.length;
  if (hasMoreThanFiveLines) {
    gutterWidth = Math.max(ELLIPSIS.length, gutterWidth);
  }
  let context = "";
  for (let i = firstLine; i <= lastLine; i++) {
    context += host.getNewLine();
    if (hasMoreThanFiveLines && firstLine + 1 < i && i < lastLine - 1) {
      context +=
        indent +
        formatColorAndReset(ELLIPSIS.padStart(gutterWidth), GUTTER_STYLE) +
        GUTTER_SEPARATOR +
        host.getNewLine();
      i = lastLine - 1;
    }
    const lineStart = positionOfLine(file, i);
    const lineEnd = i < lastLineInFile ? positionOfLine(file, i + 1) : file.text.length;
    const lineContent = file.text.slice(lineStart, lineEnd).trimEnd().replaceAll("\t", " ");
    context +=
      indent +
      formatColorAndReset(`${i + 1}`.padStart(gutterWidth), GUTTER_STYLE) +
      GUTTER_SEPARATOR;
    context += lineContent + host.getNewLine();
    context +=
      indent + formatColorAndReset("".padStart(gutterWidth), GUTTER_STYLE) + GUTTER_SEPARATOR;
    context += squiggleColor;
    if (i === firstLine) {
      const lastCharForLine = i === lastLine ? lastLineChar : undefined;
      context += lineContent.slice(0, firstLineChar).replaceAll(/\S/g, " ");
      context += lineContent.slice(firstLineChar, lastCharForLine).replaceAll(/./g, "~");
    } else if (i === lastLine) {
      context += lineContent.slice(0, lastLineChar).replaceAll(/./g, "~");
    } else {
      context += lineContent.replaceAll(/./g, "~");
    }
    context += RESET;
  }
  return context;
};

export const flattenDiagnosticMessageText = (
  diagnostic: string | DiagnosticMessageChain | undefined,
  newLine: string,
  indent = 0,
): string => {
  if (typeof diagnostic === "string") {
    return diagnostic;
  }
  if (diagnostic === undefined) {
    return "";
  }
  let result = "";
  if (indent > 0) {
    result += newLine + "  ".repeat(indent);
  }
  result += diagnostic.messageText;
  for (const child of diagnostic.next ?? []) {
    result += flattenDiagnosticMessageText(child, newLine, indent + 1);
  }
  return result;
};

export const formatDiagnosticsWithColorAndContext = (
  diagnostics: ReadonlyArray<Diagnostic>,
  host: FormatDiagnosticsHost,
): string => {
  let output = "";
  for (const diagnostic of diagnostics) {
    if (diagnostic.file !== undefined) {
      output += formatLocation(diagnostic.file, diagnostic.start ?? 0, host);
      output += " - ";
    }
    output += formatColorAndReset(
      categoryName(diagnostic.category),
      categoryFormat(diagnostic.category),
    );
    output += formatColorAndReset(` TS${diagnostic.code}: `, GREY);
    output += flattenDiagnosticMessageText(diagnostic.messageText, host.getNewLine());
    if (diagnostic.file !== undefined && diagnostic.code !== FILE_APPEARS_TO_BE_BINARY) {
      output += host.getNewLine();
      output += formatCodeSpan(
        diagnostic.file,
        diagnostic.start ?? 0,
        diagnostic.length ?? 0,
        "",
        categoryFormat(diagnostic.category),
        host,
      );
    }
    if (diagnostic.relatedInformation !== undefined) {
      output += host.getNewLine();
      for (const { file, start, length, messageText } of diagnostic.relatedInformation) {
        if (file !== undefined) {
          output += host.getNewLine();
          output += HALF_INDENT + formatLocation(file, start ?? 0, host);
          output += formatCodeSpan(file, start ?? 0, length ?? 0, INDENT, CYAN, host);
        }
        output += host.getNewLine();
        output += INDENT + flattenDiagnosticMessageText(messageText, host.getNewLine());
      }
    }
    output += host.getNewLine();
  }
  return output;
};
