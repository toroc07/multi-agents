import { beforeEach, describe, expect, it } from "vitest";
import { HubError, HubState, MCP_OFFLINE_MS, type HubEvent } from "../src/hub/state.js";
import { buildProtocol } from "../src/shared/protocol.js";

let now = 1_000_000;
let events: HubEvent[] = [];
let state: HubState;

const P = "demo";

beforeEach(() => {
  now = 1_000_000;
  events = [];
  state = new HubState(undefined, { now: () => now, onEvent: (e) => events.push(e) });
  state.identify(P, "alice", { client: "claude-code", kind: "mcp", sessionId: "s1" });
  state.identify(P, "bob", { client: "codex", kind: "mcp", sessionId: "s2" });
  state.identify(P, "carol", { client: "aider", kind: "cli" });
});

function expectHubError(fn: () => unknown, status: number) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HubError);
    expect((err as HubError).status).toBe(status);
    return;
  }
  throw new Error("expected HubError");
}

describe("projects", () => {
  it("are created on first use with the github workflow", () => {
    const p = state.getProject(P);
    expect(p.workflow).toBe("github");
    expect(p.defaultBranch).toBe("main");
  });

  it("can be updated", () => {
    state.upsertProject({ id: P, workflow: "none", name: "Demo" });
    expect(state.getProject(P)).toMatchObject({ workflow: "none", name: "Demo" });
  });

  it("isolate agents, tasks and locks", () => {
    state.identify("other", "alice", { kind: "cli" });
    state.createTask(P, "alice", { title: "only in demo" });
    state.lockFiles(P, "alice", ["src"]);
    expect(state.listTasks("other")).toHaveLength(0);
    expect(state.listLocks("other")).toHaveLength(0);
    expect(() => state.lockFiles("other", "alice", ["src"])).not.toThrow();
  });
});

describe("agents", () => {
  it("rejects invalid or reserved names", () => {
    expectHubError(() => state.identify(P, "all"), 400);
    expectHubError(() => state.identify(P, "bad name"), 400);
  });

  it("rejects a second live MCP session with the same name", () => {
    expectHubError(() => state.identify(P, "alice", { kind: "mcp", sessionId: "other" }), 409);
    now += MCP_OFFLINE_MS + 1;
    expect(() => state.identify(P, "alice", { kind: "mcp", sessionId: "other" })).not.toThrow();
  });

  it("go offline after missing heartbeats and lose their locks", () => {
    state.lockFiles(P, "bob", ["src/api"]);
    now += MCP_OFFLINE_MS - 1;
    state.identify(P, "alice");
    state.sweep();
    expect(state.getAgent(P, "bob").online).toBe(true);
    now += 2;
    state.sweep();
    expect(state.getAgent(P, "bob").online).toBe(false);
    expect(state.getAgent(P, "alice").online).toBe(true);
    expect(state.listLocks(P)).toHaveLength(0);
  });

  it("disconnect releases locks immediately", () => {
    state.lockFiles(P, "alice", ["a.ts"]);
    state.disconnect(P, "alice");
    expect(state.listLocks(P)).toHaveLength(0);
    expect(state.getAgent(P, "alice").online).toBe(false);
  });
});

describe("messages", () => {
  it("delivers direct messages and broadcasts, tracking read state per agent", () => {
    state.sendMessage(P, "alice", "bob", "hi bob");
    state.sendMessage(P, "alice", "all", "hi everyone");
    expect(state.unreadCount(P, "bob")).toBe(2);
    expect(state.unreadCount(P, "carol")).toBe(1);
    expect(state.unreadCount(P, "alice")).toBe(0);

    expect(state.readMessages(P, "bob").map((m) => m.body)).toEqual(["hi bob", "hi everyone"]);
    expect(state.unreadCount(P, "bob")).toBe(0);
    expect(state.unreadCount(P, "carol")).toBe(1);
  });

  it("rejects unknown recipients and self-messages", () => {
    expectHubError(() => state.sendMessage(P, "alice", "nobody", "x"), 404);
    expectHubError(() => state.sendMessage(P, "alice", "alice", "x"), 400);
  });

  it("emits message events", () => {
    state.sendMessage(P, "alice", "bob", "x");
    expect(events.some((e) => e.type === "message")).toBe(true);
  });
});

describe("questions", () => {
  it("are answered through the hub and the answer is stored on the question", () => {
    const q = state.askQuestion(P, "bob", { to: "alice", body: "Which approach?", options: ["A", "B"] });
    expect(q).toMatchObject({ kind: "question", to: "alice", options: ["A", "B"] });
    expect(state.pendingQuestions(P).map((m) => m.id)).toEqual([q.id]);

    const answer = state.sendMessage(P, "alice", undefined, "B", q.id);
    expect(answer).toMatchObject({ kind: "answer", to: "bob", replyTo: q.id });
    expect(state.getMessage(P, q.id).answer).toMatchObject({ by: "alice", body: "B" });
    expect(state.pendingQuestions(P)).toHaveLength(0);
    expect(state.readMessages(P, "bob").map((m) => m.body)).toEqual(["B"]);
  });

  it("keep the first answer", () => {
    const q = state.askQuestion(P, "bob", { to: "all", body: "Anyone?" });
    state.sendMessage(P, "alice", undefined, "first", q.id);
    state.sendMessage(P, "carol", undefined, "second", q.id);
    expect(state.getMessage(P, q.id).answer?.body).toBe("first");
  });

  it("default to whoever last asked the agent for something", () => {
    state.identify(P, "carlos", { kind: "human" });
    state.sendMessage(P, "carlos", "bob", "please add a division guard");
    expect(state.askQuestion(P, "bob", { body: "Which option?" }).to).toBe("carlos");
  });

  it("fall back to the creator of the agent's active task, then to everyone", () => {
    expect(state.askQuestion(P, "carol", { body: "Anyone?" }).to).toBe("all");
    const t = state.createTask(P, "alice", { title: "x" });
    state.claimTask(P, "carol", t.id);
    expect(state.askQuestion(P, "carol", { body: "Details?" }).to).toBe("alice");
  });

  it("reject replies to things that are not questions", () => {
    const m = state.sendMessage(P, "alice", "bob", "hi");
    expectHubError(() => state.sendMessage(P, "bob", undefined, "re", m.id), 404);
    expectHubError(() => state.sendMessage(P, "bob", undefined, "no recipient"), 400);
  });
});

describe("tasks", () => {
  it("claim is exclusive", () => {
    const t = state.createTask(P, "alice", { title: "login" });
    expect(state.claimTask(P, "bob", t.id).assignee).toBe("bob");
    expectHubError(() => state.claimTask(P, "carol", t.id), 409);
    expect(state.claimTask(P, "bob", t.id).status).toBe("claimed");
  });

  it("assignment notifies the assignee and reserves the task", () => {
    const t = state.createTask(P, "alice", { title: "api", assignee: "bob" });
    expect(state.readMessages(P, "bob")[0]?.body).toContain(`#${t.id}`);
    expectHubError(() => state.claimTask(P, "carol", t.id), 409);
    expect(state.claimTask(P, "bob", t.id).status).toBe("claimed");
  });

  it("only owner or creator can change status; anyone can add notes", () => {
    const t = state.createTask(P, "alice", { title: "x" });
    state.claimTask(P, "bob", t.id);
    expectHubError(() => state.updateTask(P, "carol", t.id, { status: "done" }), 403);
    expect(state.updateTask(P, "carol", t.id, { note: "found a bug" }).notes).toHaveLength(1);
    const done = state.updateTask(P, "bob", t.id, { status: "review", reviewUrl: "https://example/pr/1" });
    expect(done).toMatchObject({ status: "review", reviewUrl: "https://example/pr/1" });
  });

  it("setting status back to open releases the task", () => {
    const t = state.createTask(P, "alice", { title: "x" });
    state.claimTask(P, "bob", t.id);
    state.updateTask(P, "bob", t.id, { status: "open" });
    expect(state.claimTask(P, "carol", t.id).assignee).toBe("carol");
  });

  it("done tasks cannot be claimed", () => {
    const t = state.createTask(P, "alice", { title: "x" });
    state.updateTask(P, "alice", t.id, { status: "done" });
    expectHubError(() => state.claimTask(P, "bob", t.id), 409);
  });
});

describe("locks", () => {
  it("are all-or-nothing and report the owner", () => {
    state.lockFiles(P, "alice", ["src/api"], "task #1");
    try {
      state.lockFiles(P, "bob", ["docs/readme.md", "src/api/users.ts"]);
      throw new Error("expected conflict");
    } catch (err) {
      expect((err as HubError).status).toBe(409);
      expect((err as Error).message).toContain("alice");
    }
    expect(state.listLocks(P).map((l) => l.owner)).toEqual(["alice"]);
  });

  it("re-locking your own path refreshes it", () => {
    state.lockFiles(P, "alice", ["a.ts"], "", 10);
    now += 5 * 60_000;
    state.lockFiles(P, "alice", ["A.ts"], "", 10);
    expect(state.listLocks(P)).toHaveLength(1);
    expect(state.listLocks(P)[0]!.expiresAt).toBe(now + 10 * 60_000);
  });

  it("expire after their TTL", () => {
    state.lockFiles(P, "carol", ["a.ts"], "", 1);
    now += 60_001;
    expect(state.listLocks(P)).toHaveLength(0);
    expect(() => state.lockFiles(P, "bob", ["a.ts"])).not.toThrow();
  });

  it("unlock releases only your own locks unless forced", () => {
    state.lockFiles(P, "alice", ["a.ts", "b.ts"]);
    expect(state.unlockFiles(P, "bob", ["a.ts"])).toHaveLength(0);
    expect(state.unlockFiles(P, "bob", ["a.ts"], true)).toHaveLength(1);
    expect(state.unlockFiles(P, "alice")).toHaveLength(1);
    expect(state.listLocks(P)).toHaveLength(0);
  });
});

describe("snapshot", () => {
  it("round-trips through JSON", () => {
    state.createTask(P, "alice", { title: "persist me" });
    state.sendMessage(P, "alice", "bob", "hello");
    const restored = new HubState(JSON.parse(JSON.stringify(state.snapshot())), { now: () => now });
    expect(restored.listTasks(P)[0]?.title).toBe("persist me");
    expect(restored.unreadCount(P, "bob")).toBe(1);
    expect(restored.createTask(P, "bob", { title: "next" }).id).toBe(2);
  });
});

describe("protocol", () => {
  it("adapts to the workflow", () => {
    const github = buildProtocol(state.getProject(P), { agentName: "bob", iface: "mcp" });
    expect(github).toContain("agent/bob");
    expect(github).toContain("gh pr create");
    expect(github).toContain("`claim_task`");
    expect(github).toContain("Never ask in your local console");
    expect(github).toContain("`ask`");

    state.upsertProject({ id: P, workflow: "none" });
    const none = buildProtocol(state.getProject(P), { iface: "cli" });
    expect(none).toContain("mandatory");
    expect(none).not.toContain("git switch");
    expect(none).toContain("multi-agents task claim");
  });
});
