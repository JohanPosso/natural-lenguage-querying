import type { Request, Response } from "express";
import { debugLogger } from "../services/debugLogger";

export async function getDebugLogsController(req: Request, res: Response): Promise<Response> {
  try {
    const channelRaw = String(req.query.channel ?? "ask").toLowerCase();
    const channel = channelRaw === "chat" ? "chat" : "ask";
    const lines = Number(req.query.lines ?? 200);
    const traceId = String(req.query.traceId ?? "").trim();

    const entries = await debugLogger.readLast(channel, lines);
    const filtered = traceId
      ? entries.filter((entry) => {
          try {
            const parsed = JSON.parse(entry) as { traceId?: string };
            return parsed.traceId === traceId;
          } catch {
            return false;
          }
        })
      : entries;

    return res.status(200).json({ channel, lines: filtered.length, logs: filtered });
  } catch (error) {
    return res.status(500).json({ code: "DEBUG_LOGS_ERROR", error: (error as Error).message });
  }
}

/**
 * Returns a human-friendly summary of recent queries grouped by traceId.
 * Each entry shows: question, cube, measures, filters, MDX queries, values, answer, timing.
 */
export async function getDebugSummaryController(req: Request, res: Response): Promise<Response> {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const entries = await debugLogger.readLast("ask", 2000);

    // Group events by traceId
    const byTrace = new Map<string, Array<Record<string, unknown>>>();
    const order: string[] = [];

    for (const raw of entries) {
      try {
        const ev = JSON.parse(raw) as Record<string, unknown>;
        const id = String(ev.traceId ?? "unknown");
        if (!byTrace.has(id)) {
          byTrace.set(id, []);
          order.push(id);
        }
        byTrace.get(id)!.push(ev);
      } catch {
        // skip malformed lines
      }
    }

    // Build summary for each trace (most recent first)
    const summaries = order
      .slice(-limit)
      .reverse()
      .map((id) => {
        const events = byTrace.get(id)!;
        const find = (evName: string) => events.find((e) => e.event === evName);

        const start = find("pipeline_start");
        const success = find("pipeline_success");
        const error = find("pipeline_error");
        const selection = find("llm_selection");

        const mdxAttempts = events
          .filter((e) => e.event === "mdx_success" || e.event === "mdx_error")
          .map((e) => ({
            status: e.event === "mdx_success" ? "ok" : "error",
            measure: e.measure,
            label: e.label,
            value: e.value ?? null,
            mdx: typeof e.mdx === "string" ? e.mdx : undefined,
            error: e.error ?? null
          }));

        const resolvedFilters = events
          .filter((e) => e.event === "filter_resolved")
          .map((e) => ({
            hierarchy: e.hierarchy,
            value: e.value,
            resolved: e.resolved
          }));

        const notFoundFilters = events
          .filter((e) => e.event === "filter_not_found")
          .map((e) => ({ hierarchy: e.hierarchy, value: e.value }));

        return {
          traceId: id,
          ts: start?.ts ?? null,
          status: error ? "error" : success ? "ok" : "incomplete",
          question: start?.prompt ?? null,
          elapsed_ms: success?.elapsed_ms ?? null,
          cube: success?.cube ?? (selection?.selection as Record<string, unknown> | undefined)?.cube_name ?? null,
          measures: ((selection?.selection as Record<string, unknown> | undefined)?.measures as unknown[] | undefined)?.map(
            (m) => (m as Record<string, unknown>).friendly_name
          ) ?? [],
          filters_requested: ((selection?.selection as Record<string, unknown> | undefined)?.filters as unknown[] | undefined)?.map(
            (f) => {
              const filter = f as Record<string, unknown>;
              return `${filter.friendly_name ?? filter.hierarchy_mdx}=${(filter.values as string[] | undefined)?.join(",") ?? ""}`;
            }
          ) ?? [],
          filters_resolved: resolvedFilters,
          filters_not_found: notFoundFilters,
          mdx_queries: mdxAttempts,
          answer: success?.answer ?? null,
          error: error?.error ?? null
        };
      });

    return res.status(200).json({ total: summaries.length, queries: summaries });
  } catch (error) {
    return res.status(500).json({ code: "DEBUG_SUMMARY_ERROR", error: (error as Error).message });
  }
}
