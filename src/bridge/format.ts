import { currentStatus } from "../shared/activity.js";
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

export type Iface = "mcp" | "cli";

export function replyHint(id: number, iface: Iface): string {
  return iface === "mcp"
    ? `answer with send_message(reply_to=${id}, body=...)`
    : `answer with: multi-agents msg send --reply-to ${id} "<answer>"`;
}

export function fmtMessage(m: Message, iface: Iface = "mcp"): string {
  const head = `[#${m.id} ${ago(m.createdAt)}] ${m.from} → ${m.to}`;
  if (m.kind === "question") {
    const lines = [`${head} ❓ QUESTION: ${m.body}`];
    if (m.options?.length) lines.push(`   options: ${m.options.map((o, i) => `${i + 1}) ${o}`).join("  ")}`);
    lines.push(m.answer ? `   answered by ${m.answer.by}: ${m.answer.body}` : `   (${replyHint(m.id, iface)})`);
    return lines.join("\n");
  }
  if (m.kind === "answer") return `${head} ↩ answer to #${m.replyTo}: ${m.body}`;
  if (m.kind === "event") return `[#${m.id} ${ago(m.createdAt)}] 📢 hub: ${m.body}`;
  return `${head}: ${m.body}`;
}

export function fmtAskResult(
  res: { question: Message; answer?: Message; others: Message[] },
  timeoutS: number,
  iface: Iface = "mcp",
): string {
  const lines = [`Question #${res.question.id} sent to ${res.question.to}.`];
  if (res.answer) {
    lines.push(`✅ Answer from ${res.answer.from}: ${res.answer.body}`);
  } else {
    const wait = iface === "mcp" ? "call wait_for_messages" : "run `multi-agents msg wait`";
    lines.push(
      `No answer yet after ${timeoutS}s. Continue with work that does not depend on it, or ${wait}; ` +
        `the answer will arrive as a message "↩ answer to #${res.question.id}". Do not ask in your local console instead.`,
    );
  }
  if (res.others.length) lines.push("", "Other messages received meanwhile:", fmtMessages(res.others, iface));
  return lines.join("\n");
}

export function fmtMessages(messages: Message[], iface: Iface = "mcp"): string {
  if (!messages.length) return "No new messages.";
  return messages.map((m) => fmtMessage(m, iface)).join("\n");
}

export function fmtAgents(agents: AgentView[], me?: string): string {
  if (!agents.length) return "No agents registered yet.";
  return agents
    .map((a) => {
      const who = `${a.online ? "●" : "○"} ${a.name}${a.name === me ? " (you)" : ""}`;
      const tool = [a.client, a.model].filter(Boolean).join(" / ");
      const status = currentStatus(a);
      const extra = [
        tool && `[${tool}]`,
        a.branch && `branch ${a.branch}`,
        status && `— ${status}`,
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

export function fmtClaimed(t: Task): string {
  return `Claimed ${fmtTaskLine(t)}${t.branch ? `\nWork on branch ${t.branch} (create it from the latest base branch if it does not exist).` : ""}`;
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
