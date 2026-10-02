import type { AgentConfig } from "../config.js";
import { buildProtocol } from "../shared/protocol.js";
import { TASK_STATUSES, WORKFLOWS, type TaskStatus, type Workflow } from "../shared/types.js";
import { HubClient, type HubResponse } from "./client.js";
import { fmtAgents, fmtAskResult, fmtClaimed, fmtLocks, fmtMessages, fmtTask, fmtTaskLine, fmtTasks, fmtUnread } from "./format.js";

/** Option values parsed by cli.ts (node:util parseArgs). */
export type Opts = Record<string, string | boolean | undefined>;

export class UsageError extends Error {}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

function int(value: string | undefined, what: string): number {
  const n = Number(value?.replace(/^#/, ""));
  if (!value || !Number.isInteger(n) || n < 1) throw new UsageError(`Expected a ${what}, got "${value ?? ""}"`);
  return n;
}

function taskStatus(value: string | undefined): TaskStatus | undefined {
  if (value === undefined) return undefined;
  if (!(TASK_STATUSES as readonly string[]).includes(value)) {
    throw new UsageError(`Invalid status "${value}". Use one of: ${TASK_STATUSES.join(", ")}`);
  }
  return value as TaskStatus;
}

/**
 * Agent commands for tools without MCP support (or humans in a terminal).
 * Returns the process exit code.
 */
export async function runAgentCommand(cfg: AgentConfig, command: string, args: string[], opts: Opts): Promise<number> {
  const client = new HubClient(cfg, { kind: "cli" });
  const json = opts.json === true;

  const out = <T>(res: HubResponse<T>, render: (data: T) => string): number => {
    if (json) console.log(JSON.stringify(res.data, null, 2));
    else console.log(render(res.data) + fmtUnread(res.unread, "run `multi-agents msg read`"));
    return 0;
  };

  const [sub, ...rest] = args;
  switch (command) {
    case "status": {
      if (!args.length && opts.branch === undefined) {
        const res = await client.register();
        return out(res, ({ agent, project }) =>
          [
            `You are "${agent.name}" [${agent.client}${agent.model ? ` / ${agent.model}` : ""}] in project "${project.name}" (${project.workflow}).`,
            `Hub: ${cfg.hubUrl}`,
            agent.status ? `Status: ${agent.status}` : `Status: (none) — set it with: multi-agents status "what you are doing"`,
          ].join("\n"),
        );
      }
      const res = await client.updateMe({ status: args.length ? args.join(" ") : undefined, branch: str(opts.branch) });
      return out(res, (a) => `Status updated: ${a.status}${a.branch ? ` (branch ${a.branch})` : ""}`);
    }

    case "agents":
      return out(await client.listAgents(), (agents) => fmtAgents(agents, cfg.agentName));

    case "protocol": {
      const res = await client.getProject("cli");
      return out(res, ({ project }) => buildProtocol(project, { agentName: cfg.agentName, iface: "cli" }));
    }

    case "msg":
      switch (sub) {
        case "send": {
          const replyTo = str(opts["reply-to"]) ? int(str(opts["reply-to"]), "question id") : undefined;
          const [to, ...words] = replyTo === undefined ? rest : [undefined, ...rest];
          if ((!to && replyTo === undefined) || !words.length) {
            throw new UsageError('Usage: multi-agents msg send <agent|all> "<text>"  |  msg send --reply-to <id> "<answer>"');
          }
          return out(await client.sendMessage(to, words.join(" "), replyTo), (m) =>
            m.replyTo ? `Answered question #${m.replyTo} (message #${m.id} to ${m.to}).` : `Sent message #${m.id} to ${m.to}.`,
          );
        }
        case "read":
          return out(await client.readMessages(opts.peek === true), (m) => fmtMessages(m, "cli"));
        case "wait": {
          const timeout = str(opts.timeout) ? int(str(opts.timeout), "timeout in seconds") : cfg.waitTimeoutS;
          return out(await client.waitForMessages(timeout), (m) =>
            m.length ? fmtMessages(m, "cli") : "No messages arrived before the timeout.",
          );
        }
        default:
          throw new UsageError("Usage: multi-agents msg <send|read|wait>");
      }

    case "ask": {
      if (!args.length) throw new UsageError('Usage: multi-agents ask "<question>" [--options "A|B|C"] [--to name] [--timeout S]');
      const timeout = str(opts.timeout) ? int(str(opts.timeout), "timeout in seconds") : cfg.waitTimeoutS;
      const options = str(opts.options)
        ?.split("|")
        .map((o) => o.trim())
        .filter(Boolean);
      const res = await client.askAndWait({ body: args.join(" "), options, to: str(opts.to) }, timeout);
      return out({ data: res, unread: res.unread }, (r) => fmtAskResult(r, timeout, "cli"));
    }

    case "task":
      switch (sub) {
        case "list":
          return out(
            await client.listTasks({
              status: taskStatus(str(opts.status)),
              assignee: opts.mine === true ? cfg.agentName : str(opts.assign),
            }),
            fmtTasks,
          );
        case "show":
          return out(await client.getTask(int(rest[0], "task id")), fmtTask);
        case "create": {
          if (!rest.length) throw new UsageError('Usage: multi-agents task create "<title>" [--desc "..."] [--assign agent]');
          return out(
            await client.createTask({ title: rest.join(" "), description: str(opts.desc), assignee: str(opts.assign) }),
            (t) => `Created ${fmtTaskLine(t)}`,
          );
        }
        case "claim":
          return out(await client.claimTask(int(rest[0], "task id")), fmtClaimed);
        case "update": {
          const id = int(rest[0], "task id");
          return out(
            await client.updateTask(id, {
              status: taskStatus(str(opts.status)),
              note: str(opts.note),
              branch: str(opts.branch),
              reviewUrl: str(opts["review-url"]),
              assignee: str(opts.assign),
            }),
            (t) => `Updated ${fmtTaskLine(t)}`,
          );
        }
        default:
          throw new UsageError("Usage: multi-agents task <list|show|create|claim|update>");
      }

    case "lock": {
      if (!args.length) throw new UsageError('Usage: multi-agents lock <paths...> [--reason "..."] [--ttl minutes]');
      const ttl = str(opts.ttl) ? Number(opts.ttl) : 30;
      return out(await client.lockFiles(args, str(opts.reason), ttl), (locks) => `Locked:\n${fmtLocks(locks)}`);
    }

    case "unlock":
      return out(await client.unlockFiles(args.length ? args : undefined, opts.force === true), (released) =>
        released.length ? `Released: ${released.map((l) => `${l.path} (${l.owner})`).join(", ")}` : "No matching locks.",
      );

    case "locks":
      return out(await client.listLocks(), fmtLocks);

    case "project":
      switch (sub) {
        case "list":
          return out(await client.listProjects(), (projects) =>
            projects.length
              ? projects.map((p) => `${p.id} — ${p.name} [${p.workflow}]${p.repoUrl ? ` ${p.repoUrl}` : ""}`).join("\n")
              : "No projects yet.",
          );
        case "show":
          return out(await client.getProject("both"), ({ project }) => JSON.stringify(project, null, 2));
        case "create":
        case "update": {
          const id = rest[0] ?? cfg.project;
          const workflow = str(opts.workflow);
          if (workflow && !(WORKFLOWS as readonly string[]).includes(workflow)) {
            throw new UsageError(`Invalid workflow "${workflow}". Use one of: ${WORKFLOWS.join(", ")}`);
          }
          return out(
            await client.upsertProject({
              id,
              name: str(opts.name),
              workflow: workflow as Workflow | undefined,
              repoUrl: str(opts.repo),
              defaultBranch: str(opts["default-branch"]),
              branchPattern: str(opts["branch-pattern"]),
              maxActiveTasks: str(opts["max-active-tasks"]) === undefined ? undefined : Number(opts["max-active-tasks"]),
            }),
            (p) => `Project "${p.id}" saved: ${p.name} [${p.workflow}] base ${p.defaultBranch}, branches ${p.branchPattern}, max active tasks ${p.maxActiveTasks ?? 1}${p.repoUrl ? `, repo ${p.repoUrl}` : ""}`,
          );
        }
        default:
          throw new UsageError("Usage: multi-agents project <list|show|create|update>");
      }

    default:
      throw new UsageError(`Unknown command "${command}". Run: multi-agents help`);
  }
}
