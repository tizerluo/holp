/**
 * Newline-delimited JSON (NDJSON) transport for the HOLP stdio control plane.
 *
 * spec §1: 编码 = newline-delimited JSON,每行一个对象。stdout 只承载协议帧;
 * 日志一律走 stderr,否则污染 NDJSON 流。
 *
 * Reader: accumulates a string buffer, splits on the newline char, tolerates
 * half lines (a line split across two chunks is held until its newline arrives).
 * Each completed line is JSON.parse'd into an object and handed to the consumer.
 *
 * Writer: serializes a value to a single line and appends exactly one "\n".
 */

/** Callback for a successfully parsed frame. */
export type FrameHandler = (frame: unknown) => void;

/** Callback for a line that could not be parsed as JSON. */
export type ParseErrorHandler = (rawLine: string, error: unknown) => void;

/**
 * Stateful NDJSON reader. Feed it arbitrary chunks (as strings); it emits one
 * parsed frame per complete `\n`-terminated line. A trailing partial line is
 * retained in the internal buffer until the rest arrives.
 */
export class NdjsonReader {
  private buffer = "";

  constructor(
    private readonly onFrame: FrameHandler,
    private readonly onParseError?: ParseErrorHandler,
  ) {}

  /** Push a chunk of bytes (already decoded to a string). */
  push(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.emitLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  /**
   * Flush any buffered final line that was not newline-terminated. Call on EOF.
   * A frame stream SHOULD newline-terminate every frame, but a well-behaved
   * reader still parses a trailing line at end-of-input.
   */
  flush(): void {
    if (this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = "";
      this.emitLine(line);
    }
  }

  private emitLine(line: string): void {
    // Tolerate blank lines / stray whitespace between frames.
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let frame: unknown;
    try {
      frame = JSON.parse(trimmed);
    } catch (error) {
      this.onParseError?.(line, error);
      return;
    }
    this.onFrame(frame);
  }
}

/** Serialize a value to one NDJSON line (JSON + trailing "\n"). */
export function encodeFrame(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

/** A sink that writes serialized frames somewhere (stdout in production). */
export type FrameWriter = (frame: unknown) => void;

/**
 * Build a FrameWriter that serializes + appends a newline and forwards the
 * resulting string to `write`. In production `write` is `process.stdout.write`;
 * in tests it can be a buffer collector.
 */
export function createWriter(write: (line: string) => void): FrameWriter {
  return (frame: unknown) => {
    write(encodeFrame(frame));
  };
}
