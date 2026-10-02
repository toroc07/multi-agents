import type { AgentActivity } from "./types.js";

/** English description of what the hub observed an agent doing (agent-facing). */
export function describeActivity(a: AgentActivity): string {
  const task = a.taskId ? `#${a.taskId}${a.title ? ` ${a.title}` : ""}` : "";
  switch (a.kind) {
    case "working":
      return `Working on ${task}`;
    case "editing":
      return `Editing ${(a.paths ?? []).join(", ")}${task ? ` (${task})` : ""}`;
    case "in_review":
      return `Waiting for review of ${task}`;
    case "blocked":
      return `Blocked on ${task}`;
    case "waiting":
      return "Waiting for messages";
    case "asking":
      return `Waiting for ${a.to ?? "someone"} to answer question #${a.questionId}`;
    case "idle":
      return "Idle";
  }
}

/**
 * The status to show: whichever is newer between the agent's own text and
 * what the hub observed, so it stays current even if the agent never calls set_status.
 */
export function currentStatus(agent: { status: string; statusAt?: number; activity?: AgentActivity }): string {
  const manualAt = agent.status ? (agent.statusAt ?? 0) : -1;
  if (agent.activity && agent.activity.at > manualAt) return describeActivity(agent.activity);
  return agent.status;
}
