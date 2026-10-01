import type { Project } from "./types.js";

/**
 * Agent-facing collaboration protocol. Written in English on purpose: every
 * model follows it reliably, and it lands in a shared AGENTS.md.
 */

export type ProtocolInterface = "mcp" | "cli" | "both";

interface Action {
  mcp: string;
  cli: string;
}

const ACTIONS = {
  project: { mcp: "get_project", cli: "multi-agents protocol" },
  agents: { mcp: "list_agents", cli: "multi-agents agents" },
  status: { mcp: "set_status", cli: 'multi-agents status "<text>"' },
  send: { mcp: "send_message", cli: 'multi-agents msg send <agent|all> "<text>"' },
  read: { mcp: "read_messages", cli: "multi-agents msg read" },
  wait: { mcp: "wait_for_messages", cli: "multi-agents msg wait" },
  tasks: { mcp: "list_tasks", cli: "multi-agents task list" },
  create: { mcp: "create_task", cli: 'multi-agents task create "<title>" --desc "<details>"' },
  claim: { mcp: "claim_task", cli: "multi-agents task claim <id>" },
  update: { mcp: "update_task", cli: "multi-agents task update <id> --status <status> --note \"<text>\"" },
  lock: { mcp: "lock_files", cli: 'multi-agents lock <paths...> --reason "<why>"' },
  unlock: { mcp: "unlock_files", cli: "multi-agents unlock [paths...]" },
  locks: { mcp: "list_locks", cli: "multi-agents locks" },
} satisfies Record<string, Action>;

type ActionName = keyof typeof ACTIONS;

export function branchFor(project: Project, agent: string, task?: number | string): string {
  return project.branchPattern
    .replaceAll("{agent}", agent)
    .replaceAll("{task}", task === undefined ? "<task-id>" : String(task));
}

export function buildProtocol(
  project: Project,
  opts: { agentName?: string; iface?: ProtocolInterface } = {},
): string {
  const iface = opts.iface ?? "both";
  const me = opts.agentName;
  const a = (name: ActionName): string => {
    const act = ACTIONS[name];
    if (iface === "mcp") return `\`${act.mcp}\``;
    if (iface === "cli") return `\`${act.cli}\``;
    return `\`${act.mcp}\` (CLI: \`${act.cli}\`)`;
  };
  const branch = branchFor(project, me ?? "<your-agent-name>");
  const base = project.defaultBranch;

  const lines: string[] = [];
  lines.push(`# Multi-agent collaboration protocol`);
  lines.push("");
  lines.push(
    `${me ? `You are agent **${me}**` : "You are one of several AI agents"} in project **${project.name}** (id \`${project.id}\`), ` +
      `coordinated by a multi-agents hub. Other agents — possibly different tools and models on other machines — ` +
      `work on the same project in parallel. Coordinate through the hub; never assume you are alone.`,
  );
  if (project.repoUrl) lines.push("", `Repository: ${project.repoUrl}`);
  lines.push("");
  lines.push(`## Core rules`);
  lines.push(
    `1. **On start:** read the board and inbox: ${a("agents")}, ${a("read")}, ${a("tasks")}.`,
    `2. **One task at a time, always claimed:** pick an open task and claim it with ${a("claim")} before working. ` +
      `If none fits, create one with ${a("create")} and claim it. Never work on a task claimed by another agent.`,
    `3. **Lock before editing:** reserve the files or folders you are about to change with ${a("lock")} (folders lock everything inside). ` +
      `If a lock conflicts, message its owner with ${a("send")} or pick other work — do not edit locked paths.`,
    `4. **Stay visible:** keep your status current with ${a("status")} (what you are doing right now).`,
    `5. **Check your inbox often:** every hub response tells you how many messages are unread; read them with ${a("read")} ` +
      `and answer direct questions promptly.`,
    `6. **When you finish a task:** ${a("update")} it to \`review\` or \`done\` with a short note, release locks with ${a("unlock")}, ` +
      `and announce it to \`all\` with ${a("send")}.`,
    `7. **When blocked:** set the task to \`blocked\` with a note explaining what you need and message whoever can help.`,
    `8. **When idle:** call ${a("wait")} to wait for new messages or assignments instead of stopping.`,
    `9. Keep messages short and concrete (file paths, task ids, what you need).`,
  );
  lines.push("");
  lines.push(`## Version control — workflow \`${project.workflow}\``);
  if (project.workflow === "github" || project.workflow === "git") {
    const review = project.workflow === "github" ? "pull request" : "merge request (or whatever review flow the team uses)";
    lines.push(
      `- Work only on your own branch: \`${branch}\`. Create it from the latest \`${base}\`:`,
      `  \`git fetch origin && git switch -c ${branch} origin/${base}\` (or \`git switch ${branch}\` if it exists).`,
      `- Never commit or push directly to \`${base}\`, and never push to or rewrite another agent's branch.`,
      `- Commit small, focused changes; push your branch regularly so others can see progress.`,
      `- Before opening a ${review}, update your branch with \`git fetch origin && git rebase origin/${base}\` and resolve conflicts.`,
    );
    if (project.workflow === "github") {
      lines.push(
        `- Open the pull request against \`${base}\` (e.g. \`gh pr create --base ${base} --fill\`) and report its URL as \`reviewUrl\` when you ${a("update")}.`,
      );
    } else {
      lines.push(`- Open the ${review} against \`${base}\` and report its link (or your branch name) as \`reviewUrl\` when you ${a("update")}.`);
    }
    lines.push(`- After your branch is merged, start the next task from a fresh \`origin/${base}\`.`);
  } else {
    lines.push(
      `- This project has no version control coordinated by the hub; all agents edit the same files.`,
      `- Locks are **mandatory**: only edit files you currently hold a lock on, and release them as soon as you are done.`,
      `- Avoid broad reformatting or renaming that touches files you have not locked.`,
      `- After changing shared files (configs, interfaces, schemas), tell \`all\` what changed.`,
    );
  }
  return lines.join("\n");
}
