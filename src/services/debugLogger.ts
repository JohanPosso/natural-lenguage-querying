import { promises as fs } from "fs";
import path from "path";

type LogChannel = "ask" | "chat";

class DebugLoggerService {
  private baseDir = path.resolve(process.cwd(), "logs");

  private fileFor(channel: LogChannel): string {
    return path.join(this.baseDir, `${channel}-debug.jsonl`);
  }

  async log(channel: LogChannel, event: string, payload: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...payload
    });

    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.appendFile(this.fileFor(channel), `${line}\n`, "utf8");
  }

  async readLast(channel: LogChannel, lines = 200): Promise<string[]> {
    const safeLines = Math.min(Math.max(lines, 1), 2000);
    try {
      const content = await fs.readFile(this.fileFor(channel), "utf8");
      const all = content.split("\n").filter(Boolean);
      return all.slice(-safeLines);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}

export const debugLogger = new DebugLoggerService();
