// Ported from upstream Grats v0.0.36 src/tests/Markdown.ts (MIT). Output format is unchanged,
// because every `.expected.md` fixture snapshot depends on it.

type MarkdownSection =
  | { readonly kind: "header"; readonly level: number; readonly content: string }
  | {
      readonly kind: "codeBlock";
      readonly content: string;
      readonly fileType: string;
      readonly fileName: string | undefined;
    };

export class Markdown {
  readonly sections: Array<MarkdownSection> = [];

  addHeader(level: number, content: string): void {
    this.sections.push({ kind: "header", level, content });
  }

  addCodeBlock(content: string, fileType: string, fileName?: string): void {
    this.sections.push({ kind: "codeBlock", content, fileType, fileName });
  }

  addMarkdown(markdown: Markdown): void {
    for (const section of markdown.sections) {
      this.sections.push(section);
    }
  }

  toString(): string {
    let output = "";
    for (const section of this.sections) {
      if (section.kind === "header") {
        output += `${"#".repeat(section.level)} ${section.content}\n\n`;
      } else {
        const fileNamePart = section.fileName === undefined ? "" : ` title="${section.fileName}"`;
        output += `\`\`\`${section.fileType}${fileNamePart}\n${section.content.trimEnd()}\n\`\`\`\n\n`;
      }
    }
    return output.trim();
  }
}
