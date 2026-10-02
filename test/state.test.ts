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

describe("coordination (v0.2)", () => {
  it("announces task changes to everyone except the actor", () => {
    const t = state.createTask(P, "alice", { title: "login" });
    state.claimTask(P, "bob", t.id);
    state.updateTask(P, "bob", t.id, { status: "review", note: "tests pass" });
    const forCarol = state.readMessages(P, "carol").filter((m) => m.kind === "event");
    expect(forCarol.map((m) => m.body)).toEqual([
      expect.stringContaining('alice created #1 "login"'),
      expect.stringContaining("bob claimed #1"),
      expect.stringContaining("bob moved #1"),
    ]);
    expect(state.readMessages(P, "bob").some((m) => m.kind === "event" && m.actor === "bob")).toBe(false);
  });

  it("lets a reviewer close or send back a task in review, but not touch it before", () => {
    const t = state.createTask(P, "alice", { title: "x" });
    state.claimTask(P, "bob", t.id);
    expectHubError(() => state.updateTask(P, "carol", t.id, { status: "done" }), 403);
    state.updateTask(P, "bob", t.id, { status: "review" });
    expectHubError(() => state.updateTask(P, "carol", t.id, { status: "open" }), 403);
    const back = state.updateTask(P, "carol", t.id, { status: "in_progress", note: "add tests" });
    expect(back).toMatchObject({ status: "in_progress", assignee: "bob" });
    state.updateTask(P, "bob", t.id, { status: "review" });
    expect(state.updateTask(P, "carol", t.id, { status: "done" })).toMatchObject({ status: "done", assignee: "bob" });
  });

  it("lets humans change any task", () => {
    state.identify(P, "carlos", { kind: "human" });
    const t = state.createTask(P, "alice", { title: "x" });
    state.claimTask(P, "bob", t.id);
    expect(state.updateTask(P, "carlos", t.id, { status: "done" }).status).toBe("done");
  });

  it("limits active tasks per agent (default 1, configurable, 0 = unlimited)", () => {
    const a = state.createTask(P, "alice", { title: "a" });
    const b = state.createTask(P, "alice", { title: "b" });
    state.claimTask(P, "bob", a.id);
    expectHubError(() => state.claimTask(P, "bob", b.id), 409);
    state.updateTask(P, "bob", a.id, { status: "review" });
    expect(state.claimTask(P, "bob", b.id).assignee).toBe("bob");

    state.upsertProject({ id: P, maxActiveTasks: 0 });
    const c = state.createTask(P, "alice", { title: "c" });
    expect(state.claimTask(P, "bob", c.id).assignee).toBe("bob");
  });

  it("assigns a per-task branch on claim (not for workflow none)", () => {
    const t = state.createTask(P, "alice", { title: "x" });
    expect(state.claimTask(P, "bob", t.id).branch).toBe(`agent/bob/task-${t.id}`);
    expect(state.getAgent(P, "bob").branch).toBe(`agent/bob/task-${t.id}`);

    state.upsertProject({ id: "plain", workflow: "none" });
    state.identify("plain", "bob");
    state.identify("plain", "alice");
    const u = state.createTask("plain", "alice", { title: "y" });
    expect(state.claimTask("plain", "bob", u.id).branch).toBeUndefined();
  });

  it("tracks each agent's activity automatically, but a newer manual status wins", () => {
    const t = state.createTask(P, "alice", { title: "login" });
    now += 1;
    state.claimTask(P, "bob", t.id);
    expect(state.getAgent(P, "bob").activity).toMatchObject({ kind: "working", taskId: t.id });
    now += 1;
    state.lockFiles(P, "bob", ["src/login.ts"]);
    expect(state.getAgent(P, "bob").activity).toMatchObject({ kind: "editing", paths: ["src/login.ts"] });
    now += 1;
    state.unlockFiles(P, "bob");
    expect(state.getAgent(P, "bob").activity?.kind).toBe("working");
    now += 1;
    state.updateAgent(P, "bob", { status: "Writing the form" });
    const agent = state.getAgent(P, "bob");
    expect(agent.statusAt).toBeGreaterThan(agent.activity!.at);
    now += 1;
    state.beginWait(P, "bob");
    expect(state.getAgent(P, "bob").activity?.kind).toBe("waiting");
    state.endWait(P, "bob");
    expect(state.getAgent(P, "bob").activity?.kind).toBe("working");
    state.updateTask(P, "bob", t.id, { status: "review" });
    expect(state.getAgent(P, "bob").activity?.kind).toBe("in_review");
  });

  it("keeps an activity log with lock conflicts and releases", () => {
    state.lockFiles(P, "alice", ["src"]);
    expect(() => state.lockFiles(P, "bob", ["src/a.ts"])).toThrow();
    state.disconnect(P, "alice");
    const types = state.log(P).map((e) => `${e.type}:${e.actor}${e.reason ? `:${e.reason}` : ""}`);
    expect(types).toEqual(
      expect.arrayContaining(["lock.acquired:alice", "lock.conflict:bob", "agent.disconnected:alice:closed", "lock.released:alice:disconnect"]),
    );
    expect(state.log(P).find((e) => e.type === "lock.conflict")?.target).toBe("alice");
  });

  it("removes offline agents, releasing their locks and reopening their active tasks", () => {
    state.identify(P, "carlos", { kind: "human" });
    const t = state.createTask(P, "alice", { title: "x" });
    state.claimTask(P, "carol", t.id);
    state.lockFiles(P, "carol", ["a.ts"]);
    expectHubError(() => state.removeAgent(P, "carol", "carlos"), 409);

    now += 11 * 60_000; // carol is a CLI agent: offline after 10 min without calls
    state.identify(P, "carlos");
    state.removeAgent(P, "carol", "carlos");
    expect(state.listAgents(P).map((a) => a.name)).not.toContain("carol");
    expect(state.listLocks(P)).toHaveLength(0);
    expect(state.getTask(P, t.id)).toMatchObject({ status: "open", assignee: undefined });
    expect(state.log(P).at(-1)).toMatchObject({ type: "agent.removed", actor: "carlos", target: "carol" });
  });

  it("starts newcomers with an empty inbox", () => {
    state.sendMessage(P, "alice", "all", "old news");
    state.identify(P, "dave");
    expect(state.unreadCount(P, "dave")).toBe(0);
    state.sendMessage(P, "alice", "all", "fresh");
    expect(state.readMessages(P, "dave").map((m) => m.body)).toEqual(["fresh"]);
  });

  it("loads v0.1 state files without a log", () => {
    const old = JSON.parse(JSON.stringify(state.snapshot()));
    for (const ps of Object.values(old.projects) as Record<string, unknown>[]) {
      delete ps.log;
      delete ps.nextLogId;
    }
    const restored = new HubState(old, { now: () => now });
    expect(() => restored.lockFiles(P, "alice", ["x.ts"])).not.toThrow();
    expect(restored.log(P)).toHaveLength(1);
  });
});

describe("snapshot", () => {
  it("round-trips through JSON", () => {
    state.createTask(P, "alice", { title: "persist me" });
    state.sendMessage(P, "alice", "bob", "hello");
    const restored = new HubState(JSON.parse(JSON.stringify(state.snapshot())), { now: () => now });
    expect(restored.listTasks(P)[0]?.title).toBe("persist me");
    expect(restored.readMessages(P, "bob").map((m) => m.body)).toContain("hello");
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
