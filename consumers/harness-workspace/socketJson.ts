import net from "node:net";

export interface JsonSocketOptions {
  readonly onMessage: (message: unknown) => void;
  readonly onMalformed?: (line: string) => void;
}

export function attachJsonLineSocket(socket: net.Socket, options: JsonSocketOptions): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) readLine(line, options);
      newline = buffer.indexOf("\n");
    }
  });
}

export function writeJsonLine(socket: net.Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

function readLine(line: string, options: JsonSocketOptions): void {
  try {
    options.onMessage(JSON.parse(line));
  } catch {
    options.onMalformed?.(line);
  }
}
