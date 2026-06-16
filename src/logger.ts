import { appendFile } from "node:fs/promises";

type Level = "INFO" | "WARN" | "ERROR" | "CHANGE";

/**
 * Tiny logger that mirrors every line to stdout/stderr and appends it to a
 * local log file. Status changes use the dedicated CHANGE level so they are
 * easy to grep out of the run log.
 */
export class Logger {
  constructor(private readonly file: string) {}

  private async write(level: Level, message: string): Promise<void> {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`;
    if (level === "ERROR") {
      console.error(line);
    } else {
      console.log(line);
    }
    try {
      await appendFile(this.file, line + "\n");
    } catch (err) {
      console.error(`[logger] failed to write log file: ${String(err)}`);
    }
  }

  info(message: string): Promise<void> {
    return this.write("INFO", message);
  }

  warn(message: string): Promise<void> {
    return this.write("WARN", message);
  }

  error(message: string): Promise<void> {
    return this.write("ERROR", message);
  }

  /** Records a status transition applied to a Notion row. */
  change(book: string, status: string, detail: string): Promise<void> {
    return this.write("CHANGE", `"${book}" → ${status} (${detail})`);
  }
}
