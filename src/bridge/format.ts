import type { AgentView, Lock, Message, Task } from "../shared/types.js";

/** Plain-text renderers shared by the MCP tools and the CLI; compact so they cost agents few tokens. */

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function inMinutes(ts: number, now = Date.now()): string {
  return `${Math.max(0, Math.round((ts - now) / 60_000))}m`;
}

export function fmtMessages(messages: Message[]): string {
  if (!messages.length) return "No new messages.";
  return messages
    .map((m) => `[#${m.id} ${ago(m.createdAt)}] ${m.from} → ${m.to === "all" ? "all" : m.to}: ${m.body}`)
    .join("\n");
}

export function fmtAgents(agents: AgentView[], me?: string): string {
  if (!agents.length) return "No agents registered yet.";
  return agents
    .map((a) => {
      const who = `${a.online ? "●" : "○"} ${a.name}${a.name === me ? " (you)" : ""}`;
      const tool = [a.client, a.model].filter(Boolean).join(" / ");
      const extra = [
        tool && `[${tool}]`,
        a.branch && `branch ${a.branch}`,
        a.status && `— ${a.status}`,
        !a.online && `(last seen ${ago(a.lastSeen)})`,
      ]
        .filter(Boolean)
        .join(" ");
      return `${who} ${extra}`.trim();
    })
    .join("\n");
}

export function fmtTaskLine(t: Task): string {
  const parts = [`#${t.id} [${t.status}] ${t.title}`];
  if (t.assignee) parts.push(`@${t.assignee}`);
  if (t.branch) parts.push(`branch ${t.branch}`);
  if (t.reviewUrl) parts.push(`review ${t.reviewUrl}`);
  return parts.join(" · ");
}

export function fmtTasks(tasks: Task[]): string {
  if (!tasks.length) return "No tasks match.";
  return tasks.map(fmtTaskLine).join("\n");
}

export function fmtTask(t: Task): string {
  const lines = [fmtTaskLine(t), `created by ${t.createdBy} ${ago(t.createdAt)}, updated ${ago(t.updatedAt)}`];
  if (t.description) lines.push("", t.description);
  if (t.notes.length) {
    lines.push("", "Notes:");
    for (const n of t.notes) lines.push(`- ${n.author} (${ago(n.at)}): ${n.text}`);
  }
  return lines.join("\n");
}

export function fmtLocks(locks: Lock[]): string {
  if (!locks.length) return "No active locks.";
  return locks
    .map((l) => `${l.path} — ${l.owner}${l.reason ? ` (${l.reason})` : ""}, expires in ${inMinutes(l.expiresAt)}`)
    .join("\n");
}

export function fmtUnread(unread: number, readHint: string): string {
  if (unread <= 0) return "";
  return `\n\n📬 You have ${unread} unread message${unread === 1 ? "" : "s"} — ${readHint}.`;
}
