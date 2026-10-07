import type { LogLevel } from "../config.js";

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, info: 2, debug: 3 };

/** Structured logger. Always writes to stderr so stdout stays clean for MCP stdio. */
export class Logger {
  constructor(private level: LogLevel = "info") {}
  private emit(l: LogLevel, msg: string, meta?: unknown) {
    if (ORDER[l] > ORDER[this.level]) return;
    const line = { t: new Date().toISOString(), level: l, msg, ...(meta ? { meta } : {}) };
    process.stderr.write(JSON.stringify(line) + "\n");
  }
  error(msg: string, meta?: unknown) { this.emit("error", msg, meta); }
  info(msg: string, meta?: unknown) { this.emit("info", msg, meta); }
  debug(msg: string, meta?: unknown) { this.emit("debug", msg, meta); }
}
