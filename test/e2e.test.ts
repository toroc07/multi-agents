import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
        "whoami", "get_project", "list_agents", "set_status", "send_message", "read_messages", "wait_for_messages",
        "list_tasks", "get_task", "create_task", "claim_task", "update_task", "lock_files", "unlock_files", "list_locks",
      ]),
    );
    expect(alice.getInstructions()).toContain("agent/alice");
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

  it("keeps projects isolated and adapts instructions to the workflow", async () => {
    hub.state.upsertProject({ id: "shared-folder", workflow: "none" });
    const dave = await mcpAgent("dave", "shared-folder");
    expect(dave.getInstructions()).toContain("mandatory");
    expect(dave.getInstructions()).not.toContain("git switch");
    expect((await call(dave, "list_tasks")).text).toBe("No tasks match.");
    expect((await call(dave, "lock_files", { paths: ["src/auth"] })).isError).toBe(false);
  });
});
