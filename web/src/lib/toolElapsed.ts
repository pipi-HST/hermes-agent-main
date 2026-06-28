export interface ToolElapsedInput {
  status: "running" | "done" | "error";
  startedAt: number;
  completedAt?: number;
}

export function elapsedMsForTool(
  tool: ToolElapsedInput,
  now: number,
): number | null {
  if (tool.startedAt <= 0) return null;
  return Math.max(0, (tool.completedAt ?? now) - tool.startedAt);
}
