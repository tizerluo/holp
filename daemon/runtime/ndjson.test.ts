import { describe, it, expect } from "vitest";
import { NdjsonReader, encodeFrame, createWriter } from "./ndjson.js";

describe("NdjsonReader", () => {
  it("parses multiple frames from a single multi-line chunk", () => {
    const frames: unknown[] = [];
    const reader = new NdjsonReader((f) => frames.push(f));
    reader.push('{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(frames).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("tolerates a half line split across chunks", () => {
    const frames: unknown[] = [];
    const reader = new NdjsonReader((f) => frames.push(f));
    reader.push('{"hello":"wor');
    expect(frames).toEqual([]); // nothing emitted until the newline arrives
    reader.push('ld"}\n');
    expect(frames).toEqual([{ hello: "world" }]);
  });

  it("holds a trailing partial frame until its newline, then flush emits an unterminated final line", () => {
    const frames: unknown[] = [];
    const reader = new NdjsonReader((f) => frames.push(f));
    reader.push('{"x":1}\n{"y":2}'); // second frame has no trailing newline
    expect(frames).toEqual([{ x: 1 }]);
    reader.flush();
    expect(frames).toEqual([{ x: 1 }, { y: 2 }]);
  });

  it("skips blank lines and routes unparseable lines to the error handler", () => {
    const frames: unknown[] = [];
    const errors: string[] = [];
    const reader = new NdjsonReader(
      (f) => frames.push(f),
      (raw) => errors.push(raw),
    );
    reader.push('\n{"ok":true}\nnot json\n');
    expect(frames).toEqual([{ ok: true }]);
    expect(errors).toEqual(["not json"]);
  });
});

describe("writer", () => {
  it("encodeFrame appends exactly one newline", () => {
    expect(encodeFrame({ a: 1 })).toBe('{"a":1}\n');
  });

  it("createWriter serializes and forwards a newline-terminated line", () => {
    const out: string[] = [];
    const write = createWriter((line) => out.push(line));
    write({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(out).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n']);
  });
});
