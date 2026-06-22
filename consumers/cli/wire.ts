import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";

export interface EventFrame {
  seq: number;
  category: string;
  name: string;
  run_id: string;
  payload: unknown;
}

export interface RpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcError extends Error {
  readonly payload: RpcErrorPayload;

  constructor(payload: RpcErrorPayload) {
    super(payload.message);
    this.name = "RpcError";
    this.payload = payload;
  }
}

interface DaemonClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly raw?: boolean;
  readonly onRawFrame?: (direction: "in" | "out", frame: unknown) => void;
  readonly stderr?: "inherit" | "pipe";
}

interface PendingResponse {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

let nextRequestId = 0;

export class DaemonClient {
  private readonly proc: ChildProcess;
  private readonly raw: boolean;
  private readonly onRawFrame?: (direction: "in" | "out", frame: unknown) => void;
  private readonly pending = new Map<number, PendingResponse>();
  private eventListeners: Array<(event: EventFrame) => void> = [];

  constructor(options: DaemonClientOptions) {
    this.raw = options.raw === true;
    this.onRawFrame = options.onRawFrame;
    this.proc = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", options.stderr ?? "inherit"],
      detached: true,
    });
    this.proc.on("error", (err) => this.rejectAll(err));

    const rl = createInterface({ input: this.proc.stdout!, terminal: false });
    rl.on("line", (line) => this.handleLine(line));
    rl.on("close", () => this.rejectAll(new Error("daemon stdout closed before response")));
  }

  call<T>(method: string, params: unknown, timeoutMs = 15000): Promise<T> {
    const id = ++nextRequestId;
    const frame = { jsonrpc: "2.0", id, method, params };
    this.write(frame);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`response:${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
  }

  onEvent(listener: (event: EventFrame) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((candidate) => candidate !== listener);
    };
  }

  async waitForEvent(
    predicate: (event: EventFrame) => boolean,
    label: string,
    timeoutMs = 15000,
  ): Promise<EventFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const off = this.onEvent((event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        off();
        resolve(event);
      });
    });
  }

  async close(): Promise<void> {
    this.rejectAll(new Error("daemon client closed"));
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    sendSignal(this.proc, "SIGTERM");
    const exited = waitExit(this.proc);
    const first = await Promise.race([exited, sleep(750).then(() => "timeout" as const)]);
    if (first === "exited") return;
    sendSignal(this.proc, "SIGKILL");
    await Promise.race([exited, sleep(750)]);
  }

  private write(frame: unknown): void {
    if (this.raw) this.onRawFrame?.("in", frame);
    this.proc.stdin!.write(`${JSON.stringify(frame)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (this.raw) this.onRawFrame?.("out", frame);

    const object = frame as Record<string, unknown>;
    if (object.method === "events.event") {
      const params = object.params as Record<string, unknown>;
      const event: EventFrame = {
        seq: params.seq as number,
        category: params.category as string,
        name: params.name as string,
        run_id: params.run_id as string,
        payload: params.payload,
      };
      for (const listener of this.eventListeners) listener(event);
      return;
    }

    if (object.id === undefined) return;
    const waiter = this.pending.get(object.id as number);
    if (!waiter) return;
    this.pending.delete(object.id as number);
    clearTimeout(waiter.timer);
    if (object.error) {
      waiter.reject(new RpcError(object.error as RpcErrorPayload));
    } else {
      waiter.resolve(object.result);
    }
  }

  private rejectAll(err: Error): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
      this.pending.delete(id);
    }
  }
}

export function formatRawFrame(direction: "in" | "out", frame: unknown): string {
  return `raw ${direction}: ${JSON.stringify(frame)}`;
}

function sendSignal(proc: ChildProcess, signal: NodeJS.Signals): void {
  const target = proc.pid ? -proc.pid : undefined;
  try {
    if (target !== undefined) {
      process.kill(target, signal);
    } else {
      proc.kill(signal);
    }
  } catch (error) {
    if ((error as { code?: string }).code === "ESRCH") return;
    try {
      proc.kill(signal);
    } catch {
      // Cleanup races are expected when the daemon exits naturally.
    }
  }
}

function waitExit(proc: ChildProcess): Promise<"exited"> {
  return new Promise((resolve) => {
    proc.once("exit", () => resolve("exited"));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
