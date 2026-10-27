/** Turn a Markdown answer into text that sounds natural when read aloud. */
export function toSpeakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .filter((line) => !line.trim().startsWith("|")) // tables are read badly by any TTS
    .map((line) => line.replace(/^\s*#{1,6}\s+(.*)$/, "$1."))
    .map((line) => line.replace(/^\s*[-*•]\s+/, ""))
    .join("\n")
    .replace(/(\[\d+\])+/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\.\.+/g, ".")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Splits streaming text into sentences so TTS can start speaking the first sentence while the
 * rest of the answer is still being generated. Decimals ("$58.11") and abbreviations stay intact.
 */
export class SentenceChunker {
  private buffer = "";
  private readonly minChars: number;
  private readonly maxChars: number;

  constructor(minChars = 40, maxChars = 280) {
    this.minChars = minChars;
    this.maxChars = maxChars;
  }

  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.findBoundary();
      if (cut < 0) break;
      const sentence = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (sentence) out.push(sentence);
    }
    return out;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }

  private emitted = 0;

  private findBoundary(): number {
    const cut = this.findBoundaryRaw();
    if (cut >= 0) this.emitted++;
    return cut;
  }

  private findBoundaryRaw(): number {
    const text = this.buffer;
    // Get the first words out fast: each TTS request has ~1.7s of fixed latency plus time per
    // character, so a long opening sentence is split at its first comma after ~30 chars.
    if (this.emitted === 0 && text.length > 100) {
      const comma = text.indexOf(", ", 30);
      const stop = text.search(/[.!?]\s/);
      if (comma > 0 && comma < 100 && (stop < 0 || comma < stop)) return comma + 2;
    }
    const re = /([.!?])(["')\]]*)\s+(?=[A-Z0-9"'($])|\n{2,}/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const end = match.index + match[0].length;
      const before = text.slice(0, match.index).split(/\s/).pop() || "";
      if (/^(e\.g|i\.e|etc|vs|approx|Inc|Ltd|Pty|No|Mr|Mrs|Dr)$/i.test(before)) continue;
      if (end >= this.minChars) return end;
    }
    if (text.length > this.maxChars) {
      const comma = text.lastIndexOf(", ", this.maxChars);
      return comma > this.minChars ? comma + 2 : this.maxChars;
    }
    return -1;
  }
}
