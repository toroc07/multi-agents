import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, type AgentConfig } from "../config.js";
import { branchFor, buildProtocol } from "../shared/protocol.js";
import { TASK_STATUSES, type Project } from "../shared/types.js";
import { VERSION } from "../version.js";
import { HubClient, type HubResponse } from "./client.js";
import { fmtAgents, fmtAskResult, fmtClaimed, fmtLocks, fmtMessages, fmtTask, fmtTaskLine, fmtTasks, fmtUnread } from "./format.js";

const HEARTBEAT_MS = 15_000;
const MAX_WAIT_S = 300;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Runs the stdio MCP server that connects one agent (any MCP client) to the hub. */
export async function runMcpBridge(overrides: Partial<AgentConfig> = {}, configFile?: string): Promise<void> {
  const cfg = loadConfig(overrides, configFile);
  const client = new HubClient(cfg, { kind: "mcp", sessionId: randomUUID() });
  const log = (...args: unknown[]) => console.error("[multi-agents]", ...args);

  // Stdout belongs to the MCP protocol; everything human-readable goes to stderr.
  const instructions = await loadInstructions(client, cfg, log);

  const server = new McpServer({ name: "multi-agents", version: VERSION }, { instructions });

  const ok = (text: string, unread: number): ToolResult => ({
    content: [{ type: "text", text: text + fmtUnread(unread, "call read_messages") }],
  });
  const run = async <T>(call: () => Promise<HubResponse<T>>, render: (data: T) => string): Promise<ToolResult> => {
    try {
      const res = await call();
      return ok(render(res.data), res.unread);
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  };

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "Show your agent identity, the project, its workflow and your suggested branch.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(
        () => client.register(),
        ({ agent, project }) =>
          [
            `You are "${agent.name}" (${[agent.client, agent.model].filter(Boolean).join(" / ")}) in project "${project.name}" (id ${project.id}).`,
            `Hub: ${cfg.hubUrl}`,
            `Workflow: ${project.workflow}${project.repoUrl ? ` · repo ${project.repoUrl}` : ""}`,
            project.workflow === "none" ? "No version control: lock files before editing." : `Your branches: ${branchFor(project, agent.name)} (base ${project.defaultBranch})`,
          ].join("\n"),
      ),
  );

  server.registerTool(
    "get_project",
    {
      title: "Project protocol",
      description: "Get the project's settings and the full collaboration protocol all agents must follow.",
      annotations: { readOnlyHint: true },
    },
    () => run(() => client.getProject("mcp"), ({ protocol }) => protocol),
  );

  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description: "List the agents in this project (● online / ○ offline) with their tool, model, branch and current status.",
      annotations: { readOnlyHint: true },
    },
    () => run(() => client.listAgents(), (agents) => fmtAgents(agents, cfg.agentName)),
  );

  server.registerTool(
    "set_status",
    {
      title: "Set my status",
      description:
        "Optionally add detail about what you are doing (shown to other agents and on the dashboard). The hub already tracks " +
        "your activity from your actions (claimed task, locked files, waiting), so use this only for extra context. Optionally set your git branch.",
      inputSchema: {
        status: z.string().max(300).describe("Short description of your current activity, e.g. 'Implementing #4: login form'"),
        branch: z.string().max(200).optional().describe("Git branch you are working on"),
      },
    },
    ({ status, branch }) => run(() => client.updateMe({ status, branch }), (a) => `Status updated: ${a.status}`),
  );

  server.registerTool(
    "send_message",
    {
      title: "Send message",
      description:
        "Send a message to another agent or human by name, or to \"all\" to broadcast. " +
        "To answer a question you received, pass its id as reply_to (then `to` can be omitted).",
      inputSchema: {
        to: z.string().optional().describe('Recipient name, or "all". Optional when reply_to is set'),
        body: z.string().min(1).max(20_000).describe("Message text; be concrete (task ids, file paths, what you need)"),
        reply_to: z.number().int().positive().optional().describe("Id of the question you are answering"),
      },
    },
    ({ to, body, reply_to }) =>
      run(
        () => client.sendMessage(to, body, reply_to),
        (m) => (m.replyTo ? `Answered question #${m.replyTo} (message #${m.id} to ${m.to}).` : `Sent message #${m.id} to ${m.to}.`),
      ),
  );

  server.registerTool(
    "ask",
    {
      title: "Ask a question",
      description:
        "Ask a question or request a decision THROUGH THE HUB and wait for the answer. Use this instead of asking in your " +
        "local console or chat: nobody may be watching your terminal (you may run on a remote machine). " +
        "Offer options when there are clear choices. By default it goes to whoever most recently asked you for something.",
      inputSchema: {
        question: z.string().min(1).max(5_000),
        options: z.array(z.string().min(1).max(200)).max(10).optional().describe("Suggested answers, e.g. ['Option A', 'Option B']"),
        to: z.string().optional().describe('Who should answer (agent/human name or "all"). Default: whoever gave you the request'),
        timeout_s: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_S)
          .optional()
          .describe(`Seconds to wait for the answer (default ${cfg.waitTimeoutS})`),
      },
    },
    async ({ question, options, to, timeout_s }, extra) => {
      const timeout = timeout_s ?? cfg.waitTimeoutS;
      try {
        const res = await client.askAndWait({ body: question, options, to }, timeout, extra.signal);
        return ok(fmtAskResult(res, timeout, "mcp"), res.unread);
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "read_messages",
    {
      title: "Read messages",
      description: "Return your unread messages (direct and broadcasts) and mark them as read.",
    },
    () => run(() => client.readMessages(), fmtMessages),
  );

  server.registerTool(
    "wait_for_messages",
    {
      title: "Wait for messages",
      description:
        "Block until a new message arrives (or the timeout passes), then return it. Use this when you are idle " +
        "or waiting on another agent instead of ending your turn.",
      inputSchema: {
        timeout_s: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_S)
          .optional()
          .describe(`Seconds to wait (default ${cfg.waitTimeoutS})`),
      },
    },
    ({ timeout_s }, extra) =>
      run(
        () => client.waitForMessages(timeout_s ?? cfg.waitTimeoutS, extra.signal),
        (messages) => (messages.length ? fmtMessages(messages) : "No messages arrived before the timeout. Call again to keep waiting."),
      ),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "List tasks on the shared board, optionally filtered by status or assignee.",
      inputSchema: {
        status: z.enum(TASK_STATUSES).optional(),
        assignee: z.string().optional().describe("Agent name; use your own name to see your tasks"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ status, assignee }) => run(() => client.listTasks({ status, assignee }), fmtTasks),
  );

  server.registerTool(
    "get_task",
    {
      title: "Task details",
      description: "Show a task with its full description and notes.",
      inputSchema: { id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => run(() => client.getTask(id), fmtTask),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description: "Add a task to the shared board. Optionally assign it to an agent. The hub announces it to everyone.",
      inputSchema: {
        title: z.string().min(1).max(200),
        description: z.string().max(20_000).optional().describe("What to do, acceptance criteria, relevant files"),
        assignee: z.string().optional().describe("Agent name to assign it to"),
      },
    },
    ({ title, description, assignee }) =>
      run(() => client.createTask({ title, description, assignee }), (t) => `Created ${fmtTaskLine(t)}`),
  );

  server.registerTool(
    "claim_task",
    {
      title: "Claim task",
      description:
        "Take ownership of an open task before working on it. Fails if another agent already has it, or if you already " +
        "have an active task (finish or release it first). Returns the branch to work on.",
      inputSchema: { id: z.number().int().positive() },
    },
    ({ id }) => run(() => client.claimTask(id), fmtClaimed),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Update a task you own: status (in_progress, review, done, blocked, or open to release it), a progress note, " +
        "your branch, or the review link (PR/MR URL). As a reviewer you may also move ANY task that is in review to done " +
        "(approved/merged) or back to in_progress (changes requested, explain in the note). The hub announces status changes.",
      inputSchema: {
        id: z.number().int().positive(),
        status: z.enum(TASK_STATUSES).optional(),
        note: z.string().max(5_000).optional(),
        branch: z.string().max(200).optional(),
        review_url: z.string().max(500).optional().describe("Pull/merge request URL"),
        assignee: z.string().optional().describe("Reassign to another agent"),
      },
    },
    ({ id, status, note, branch, review_url, assignee }) =>
      run(() => client.updateTask(id, { status, note, branch, reviewUrl: review_url, assignee }), (t) => `Updated ${fmtTaskLine(t)}`),
  );

  server.registerTool(
    "lock_files",
    {
      title: "Lock files",
      description:
        "Reserve files or folders (paths relative to the project root) before editing them so other agents don't touch them. " +
        "A folder locks everything inside. All-or-nothing: fails with the conflicting owner if any path is taken. " +
        "Locks are released when you disconnect or after the TTL.",
      inputSchema: {
        paths: z.array(z.string()).min(1).max(100),
        reason: z.string().max(300).optional().describe("Why, e.g. 'task #3'"),
        ttl_minutes: z.number().positive().max(1440).optional().describe("Default 60"),
      },
    },
    ({ paths, reason, ttl_minutes }) =>
      run(() => client.lockFiles(paths, reason, ttl_minutes), (locks) => `Locked:\n${fmtLocks(locks)}`),
  );

  server.registerTool(
    "unlock_files",
    {
      title: "Unlock files",
      description: "Release your locks on the given paths, or all your locks if no paths are given.",
      inputSchema: { paths: z.array(z.string()).max(100).optional() },
    },
    ({ paths }) =>
      run(
        () => client.unlockFiles(paths),
        (released) => (released.length ? `Released: ${released.map((l) => l.path).join(", ")}` : "You held no matching locks."),
      ),
  );

  server.registerTool(
    "list_locks",
    {
      title: "List locks",
      description: "Show every active file lock in the project and who owns it.",
      annotations: { readOnlyHint: true },
    },
    () => run(() => client.listLocks(), fmtLocks),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`connected as "${cfg.agentName}" to ${cfg.hubUrl} (project "${cfg.project}")`);

  const heartbeat = setInterval(() => {
    client.heartbeat().catch((err: Error) => log("heartbeat failed:", err.message));
  }, HEARTBEAT_MS);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(heartbeat);
    await Promise.race([client.disconnect().catch(() => {}), new Promise((r) => setTimeout(r, 2_000))]);
    process.exit(0);
  };
  transport.onclose = () => void shutdown();
  process.stdin.on("end", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

async function loadInstructions(client: HubClient, cfg: AgentConfig, log: (...a: unknown[]) => void): Promise<string> {
  try {
    await withTimeout(client.register(), 5_000);
    const { data } = await withTimeout(client.getProject("mcp"), 5_000);
    return data.protocol;
  } catch (err) {
    log(`could not load project protocol at startup: ${(err as Error).message}`);
    const fallback: Project = {
      id: cfg.project,
      name: cfg.project,
      workflow: "github",
      defaultBranch: "main",
      branchPattern: "agent/{agent}",
      createdAt: Date.now(),
    };
    return (
      buildProtocol(fallback, { agentName: cfg.agentName, iface: "mcp" }) +
      `\n\nNote: the hub at ${cfg.hubUrl} was unreachable when this session started (${(err as Error).message}). ` +
      `Call get_project to fetch the real project settings once it is up.`
    );
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref()),
  ]);
}
