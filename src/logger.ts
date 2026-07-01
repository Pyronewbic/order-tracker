import { appendFile } from "node:fs/promises";
import type { Redactor } from "./redact.js";

type Level = "INFO" | "WARN" | "ERROR" | "CHANGE";

/**
 * Tiny logger that mirrors every line to stdout/stderr and appends it to a
 * local log file. Status changes use the dedicated CHANGE level so they are
 * easy to grep out of the run log.
 *
 * An optional {@link Redactor} is applied to every line before it is printed or
 * written, so a leaked token in an error string never reaches `tracker.log`.
 */
export class Logger {
  private readonly redact: Redactor;

  constructor(
    private readonly file: string,
    redact?: Redactor,
  ) {
    this.redact = redact ?? ((s) => s);
  }

  private async write(level: Level, message: string): Promise<void> {
    const line = this.redact(`[${new Date().toISOString()}] [${level}] ${message}`);
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

  /**
   * Records a status transition applied to a Notion row. `source` is the Gmail
   * account label, rendered as a `[label]` prefix so multi-account runs stay
   * legible.
   */
  change(book: string, status: string, detail: string, source?: string): Promise<void> {
    const prefix = source ? `[${source}] ` : "";
    return this.write("CHANGE", `${prefix}"${book}" → ${status} (${detail})`);
  }
}
