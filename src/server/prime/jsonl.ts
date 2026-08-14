import { StringDecoder } from "node:string_decoder";

export class StrictJsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";

  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const records: string[] = [];

    this.pending += text;

    let newlineIndex = this.pending.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.pending.slice(0, newlineIndex);
      records.push(line.endsWith("\r") ? line.slice(0, -1) : line);
      this.pending = this.pending.slice(newlineIndex + 1);
      newlineIndex = this.pending.indexOf("\n");
    }

    return records;
  }

  end(): string[] {
    this.pending += this.decoder.end();
    if (this.pending.length === 0) {
      return [];
    }

    const line = this.pending.endsWith("\r")
      ? this.pending.slice(0, -1)
      : this.pending;
    this.pending = "";
    return [line];
  }
}

export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
