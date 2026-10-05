import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHub, type Hub } from "../src/hub/server.js";

/** Runs against the built CLI (npm test builds first), exactly like a real agent machine would. */
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const TOKEN = "test-token";
const run = promisify(execFile);

let hub: Hub;
let hubUrl: string;
const clients: Client[] = [];

type ToolOutput = { text: string; isError: boolean };

function env(name: string, project = "e2e", client = "test-client"): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HUB_URL: hubUrl,
    MULTI_AGENTS_TOKEN: TOKEN,
    PROJECT: project,
    AGENT_NAME: name,
    AGENT_CLIENT: client,
  };
}

async function mcpAgent(name: string, project = "e2e"): Promise<Client> {
  const client = new Client({ name: `test-${name}`, version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [CLI, "connect"], env: env(name, project), stderr: "ignore" }),
  );
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolOutput> {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content.map((c) => c.text).join("\n"), isError: !!res.isError };
}

async function cli(name: string, ...args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], { env: env(name, "e2e", "aider") });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.code ?? 1 };
  }
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error("dist/cli.js missing — run `npm run build` first (npm test does it)");
  hub = createHub({ token: TOKEN, sweepIntervalMs: 200 });
  await new Promise<void>((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
  hubUrl = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  await hub.close();
});

describe("end to end", () => {
  let alice: Client;
  let bob: Client;

  it("connects MCP agents with project-aware instructions and all tools", async () => {
    [alice, bob] = await Promise.all([mcpAgent("alice"), mcpAgent("bob")]);
    const { tools } = await alice.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "whoami", "get_project", "list_agents", "set_status", "send_message", "ask", "read_messages", "wait_for_messages",
        "list_tasks", "get_task", "create_task", "claim_task", "update_task", "lock_files", "unlock_files", "list_locks",
      ]),
    );
    expect(alice.getInstructions()).toContain("agent/alice");
    // Every tool declares an input schema and all four behaviour hints (directories reject tools without them).
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
    }
    expect(tools.find((t) => t.name === "list_tasks")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "read_messages")?.annotations?.readOnlyHint).toBe(false);
    expect((await call(bob, "list_agents")).text).toMatch(/● alice/);
  });

  it("rejects a duplicate live agent name", async () => {
    const dup = await mcpAgent("alice");
    const res = await call(dup, "whoami");
    expect(res.isError).toBe(true);
    expect(res.text).toContain("already connected");
    await dup.close();
  });

  it("wakes a waiting agent when a message arrives", async () => {
    const waiting = call(bob, "wait_for_messages", { timeout_s: 20 });
    await new Promise((r) => setTimeout(r, 300));
    await call(alice, "send_message", { to: "bob", body: "can you review #1?" });
    const res = await waiting;
    expect(res.isError).toBe(false);
    expect(res.text).toContain("alice → bob: can you review #1?");
  });

  it("lets CLI agents and MCP agents talk to each other", async () => {
    const sent = await cli("carol", "msg", "send", "all", "hello from aider");
    expect(sent.code).toBe(0);
    const inbox = await call(alice, "read_messages");
    expect(inbox.text).toContain("carol → all: hello from aider");

    await call(alice, "send_message", { to: "carol", body: "welcome" });
    const read = await cli("carol", "msg", "read");
    expect(read.stdout).toContain("alice → carol: welcome");
  });

  it("shows the unread counter on every tool result", async () => {
    await call(bob, "read_messages");
    await call(alice, "send_message", { to: "bob", body: "ping" });
    expect((await call(bob, "list_tasks")).text).toMatch(/You have 1 unread message\b/);
    expect((await call(bob, "read_messages")).text).not.toMatch(/unread/);
  });

  it("lets exactly one agent claim a task", async () => {
    const created = await call(alice, "create_task", { title: "Login form", description: "email + password" });
    const id = Number(/#(\d+)/.exec(created.text)![1]);
    const results = await Promise.all([
      call(alice, "claim_task", { id }),
      call(bob, "claim_task", { id }),
      cli("carol", "task", "claim", String(id)).then((r) => ({ text: r.stdout, isError: r.code !== 0 })),
    ]);
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
  });

  it("enforces file locks across agents and tools", async () => {
    expect((await call(alice, "lock_files", { paths: ["src/auth"], reason: "login" })).isError).toBe(false);
    const conflict = await call(bob, "lock_files", { paths: ["src/auth/session.ts"] });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toContain("alice");
    const cliConflict = await cli("carol", "lock", "src/auth");
    expect(cliConflict.code).toBe(1);
    expect((await cli("carol", "locks")).stdout).toContain("src/auth — alice");
  });

  it("releases an agent's locks when it disconnects", async () => {
    await alice.close();
    await until(() => hub.state.listLocks("e2e").length === 0);
    expect(hub.state.getAgent("e2e", "alice").online).toBe(false);
    expect((await call(bob, "lock_files", { paths: ["src/auth"] })).isError).toBe(false);
  });

  it("routes an agent's question to the human who made the request and returns the answer", async () => {
    const human = (path: string, body: unknown) =>
      fetch(`${hubUrl}/api/projects/e2e${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "x-agent": "carlos", "x-agent-kind": "human", "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    await human("/messages", { to: "bob", body: "Add a guard so division by zero is impossible" });
    await call(bob, "read_messages");
    const asking = call(bob, "ask", { question: "How should I guard it?", options: ["Throw an error", "Return null"], timeout_s: 20 });

    let question: { id: number; to: string; options: string[] } | undefined;
    await until(() => !!(question = hub.state.pendingQuestions("e2e")[0] as typeof question));
    expect(question).toMatchObject({ to: "carlos", options: ["Throw an error", "Return null"] });

    await human("/messages", { replyTo: question!.id, body: "Throw an error" });
    const res = await asking;
    expect(res.isError).toBe(false);
    expect(res.text).toContain("✅ Answer from carlos: Throw an error");
    expect(hub.state.pendingQuestions("e2e")).toHaveLength(0);
  });

  it("lets a CLI agent ask and an MCP agent answer with reply_to", async () => {
    const asking = cli("carol", "ask", "Can I take #2?", "--to", "bob", "--options", "yes|no", "--timeout", "20");
    let id = 0;
    await until(() => (id = hub.state.pendingQuestions("e2e").find((q) => q.from === "carol")?.id ?? 0) > 0);
    const inbox = await call(bob, "read_messages");
    expect(inbox.text).toContain("❓ QUESTION: Can I take #2?");
    expect(inbox.text).toContain(`reply_to=${id}`);
    expect((await call(bob, "send_message", { reply_to: id, body: "yes" })).text).toContain(`Answered question #${id}`);
    const res = await asking;
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("✅ Answer from bob: yes");
  });

  it("shows automatic status, branch per task, hub announcements and reviewer close", async () => {
    for (const t of hub.state.listTasks("e2e", { assignee: "bob" })) {
      if (t.status === "claimed" || t.status === "in_progress") await call(bob, "update_task", { id: t.id, status: "done" });
    }
    await call(bob, "read_messages");
    const created = await call(bob, "create_task", { title: "Add modulo operator" });
    const id = Number(/#(\d+)/.exec(created.text)![1]);
    const claimed = await call(bob, "claim_task", { id });
    expect(claimed.text).toContain(`Work on branch agent/bob/task-${id}`);
    expect(claimed.text).toContain("Before editing any file, lock it with lock_files");

    const agents = await cli("carol", "agents");
    expect(agents.stdout).toContain(`Working on #${id} Add modulo operator`);
    expect((await cli("carol", "msg", "read")).stdout).toContain(`📢 hub: bob claimed #${id}`);

    await call(bob, "update_task", { id, status: "review", note: "8/8 tests" });
    const reviewed = await cli("carol", "task", "update", String(id), "--status", "done", "--note", "merged");
    expect(reviewed.code).toBe(0);
    expect((await call(bob, "read_messages")).text).toContain(`carol marked #${id} "Add modulo operator" as done (assignee: bob)`);
  });

  it("starts the bridge from --config alone, with no secrets in the client config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "multi-agents-e2e-"));
    const configPath = join(dir, ".multi-agents.json");
    writeFileSync(configPath, JSON.stringify({ hubUrl, token: TOKEN, project: "e2e", agentName: "from-file", agentClient: "opencode" }));
    const env = { ...(process.env as Record<string, string>) };
    for (const k of ["HUB_URL", "MULTI_AGENTS_TOKEN", "PROJECT", "AGENT_NAME", "AGENT_CLIENT", "MULTI_AGENTS_CONFIG"]) delete env[k];
    const client = new Client({ name: "test-from-file", version: "0.0.0" });
    // cwd is elsewhere on purpose: the explicit --config must win over any lookup.
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [CLI, "connect", "--config", configPath], env, cwd: tmpdir(), stderr: "ignore" }),
    );
    clients.push(client);
    expect((await call(client, "whoami")).text).toContain('You are "from-file" (opencode) in project "e2e"');
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps projects isolated and adapts instructions to the workflow", async () => {
    hub.state.upsertProject({ id: "shared-folder", workflow: "none" });
    const dave = await mcpAgent("dave", "shared-folder");
    expect(dave.getInstructions()).toContain("mandatory");
    expect(dave.getInstructions()).not.toContain("git switch");
    expect((await call(dave, "list_tasks")).text).toBe("No tasks match.");
    expect((await call(dave, "lock_files", { paths: ["src/auth"] })).isError).toBe(false);
  });
});
