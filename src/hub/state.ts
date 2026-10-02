import { normalizePath, pathsConflict, samePath } from "../shared/paths.js";
import {
  BROADCAST,
  ID_RE,
  NAME_RE,
  type Agent,
  type AgentKind,
  type AgentView,
  type Lock,
  type Message,
  type Overview,
  type Project,
  type ProjectInput,
  type Task,
  type TaskPatch,
} from "../shared/types.js";

export class HubError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** MCP bridges heartbeat every 15 s; after this long without one they are offline and lose their locks. */
export const MCP_OFFLINE_MS = 60_000;
/** CLI / API / human participants only show up when they run a command. */
export const PASSIVE_OFFLINE_MS = 10 * 60_000;
export const DEFAULT_LOCK_TTL_MIN = 60;
export const MAX_MESSAGES_PER_PROJECT = 5_000;
const RESERVED_NAMES = new Set([BROADCAST, "hub", "system"]);

export type HubEvent =
  | { type: "project"; project: string }
  | { type: "agent"; project: string; agent: string }
  | { type: "message"; project: string; message: Message }
  | { type: "task"; project: string; taskId: number }
  | { type: "lock"; project: string };

interface ProjectState {
  project: Project;
  agents: Record<string, Agent>;
  messages: Message[];
  tasks: Record<string, Task>;
  locks: Lock[];
  nextMessageId: number;
  nextTaskId: number;
}

export interface Snapshot {
  version: 1;
  projects: Record<string, ProjectState>;
}

export interface Identity {
  client?: string;
  model?: string;
  kind?: AgentKind;
  sessionId?: string;
}

export interface HubStateOptions {
  now?: () => number;
  onEvent?: (event: HubEvent) => void;
}

export class HubState {
  private projects: Record<string, ProjectState>;
  private readonly now: () => number;
  private readonly emit: (event: HubEvent) => void;

  constructor(snapshot?: Snapshot, opts: HubStateOptions = {}) {
    this.projects = snapshot?.projects ?? {};
    this.now = opts.now ?? Date.now;
    this.emit = opts.onEvent ?? (() => {});
  }

  snapshot(): Snapshot {
    return { version: 1, projects: this.projects };
  }

  // ---------- Projects ----------

  listProjects(): Project[] {
    return Object.values(this.projects).map((p) => p.project);
  }

  getProject(id: string): Project {
    return this.ps(id).project;
  }

  hasProject(id: string): boolean {
    return id in this.projects;
  }

  /** Create or update a project. */
  upsertProject(input: ProjectInput): Project {
    const existing = this.projects[input.id];
    if (existing) {
      const p = existing.project;
      if (input.name !== undefined) p.name = input.name;
      if (input.workflow !== undefined) p.workflow = input.workflow;
      if (input.repoUrl !== undefined) p.repoUrl = input.repoUrl || undefined;
      if (input.defaultBranch !== undefined) p.defaultBranch = input.defaultBranch;
      if (input.branchPattern !== undefined) p.branchPattern = input.branchPattern;
      this.emit({ type: "project", project: p.id });
      return p;
    }
    this.ensureProject(input.id);
    return this.upsertProject(input);
  }

  /** Projects are created on first use with the default (GitHub) workflow. */
  ensureProject(id: string): ProjectState {
    const existing = this.projects[id];
    if (existing) return existing;
    if (!ID_RE.test(id)) throw new HubError(400, `Invalid project id "${id}" (use letters, digits, ".", "_", "-")`);
    const state: ProjectState = {
      project: {
        id,
        name: id,
        workflow: "github",
        defaultBranch: "main",
        branchPattern: "agent/{agent}",
        createdAt: this.now(),
      },
      agents: {},
      messages: [],
      tasks: {},
      locks: [],
      nextMessageId: 1,
      nextTaskId: 1,
    };
    this.projects[id] = state;
    this.emit({ type: "project", project: id });
    return state;
  }

  // ---------- Agents & presence ----------

  /**
   * Registers the agent on first contact and refreshes its presence on every
   * later call. Rejects a second live MCP session that reuses a name.
   */
  identify(projectId: string, name: string, info: Identity = {}): Agent {
    const ps = this.ensureProject(projectId);
    if (!NAME_RE.test(name) || RESERVED_NAMES.has(name.toLowerCase())) {
      throw new HubError(400, `Invalid agent name "${name}" (letters, digits, ".", "_", "-"; max 40; not "all")`);
    }
    const now = this.now();
    const agent = ps.agents[name];
    if (!agent) {
      const created: Agent = {
        name,
        client: info.client ?? "unknown",
        model: info.model,
        kind: info.kind ?? "cli",
        status: "",
        sessionId: info.sessionId,
        connectedAt: now,
        lastSeen: now,
        lastReadId: 0,
        disconnected: false,
      };
      ps.agents[name] = created;
      this.emit({ type: "agent", project: projectId, agent: name });
      return created;
    }
    if (
      info.sessionId &&
      agent.sessionId &&
      agent.sessionId !== info.sessionId &&
      agent.kind === "mcp" &&
      this.isOnline(agent)
    ) {
      throw new HubError(
        409,
        `Agent name "${name}" is already connected from another session. ` +
          `Pick a different AGENT_NAME, or wait ~${MCP_OFFLINE_MS / 1000}s if that session just closed.`,
      );
    }
    const wasOnline = this.isOnline(agent);
    if (info.client) agent.client = info.client;
    if (info.model !== undefined) agent.model = info.model || undefined;
    if (info.kind) agent.kind = info.kind;
    if (info.sessionId) {
      if (agent.sessionId !== info.sessionId) agent.connectedAt = now;
      agent.sessionId = info.sessionId;
    }
    agent.lastSeen = now;
    agent.disconnected = false;
    if (!wasOnline || info.client || info.kind) this.emit({ type: "agent", project: projectId, agent: name });
    return agent;
  }

  disconnect(projectId: string, name: string): void {
    const ps = this.ps(projectId);
    const agent = ps.agents[name];
    if (!agent) return;
    agent.disconnected = true;
    this.releaseAllLocks(ps, name);
    this.emit({ type: "agent", project: projectId, agent: name });
  }

  updateAgent(projectId: string, name: string, patch: { status?: string; branch?: string }): Agent {
    const agent = this.agent(projectId, name);
    if (patch.status !== undefined) agent.status = patch.status;
    if (patch.branch !== undefined) agent.branch = patch.branch || undefined;
    this.emit({ type: "agent", project: projectId, agent: name });
    return agent;
  }

  listAgents(projectId: string): AgentView[] {
    return Object.values(this.ps(projectId).agents)
      .map((a) => this.view(a))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }

  getAgent(projectId: string, name: string): AgentView {
    return this.view(this.agent(projectId, name));
  }

  isOnline(agent: Agent): boolean {
    if (agent.disconnected) return false;
    const limit = agent.kind === "mcp" ? MCP_OFFLINE_MS : PASSIVE_OFFLINE_MS;
    return this.now() - agent.lastSeen < limit;
  }

  /** Marks silent MCP agents offline (releasing their locks) and drops expired locks. */
  sweep(): void {
    const now = this.now();
    for (const [projectId, ps] of Object.entries(this.projects)) {
      for (const agent of Object.values(ps.agents)) {
        if (agent.kind === "mcp" && !agent.disconnected && now - agent.lastSeen >= MCP_OFFLINE_MS) {
          agent.disconnected = true;
          this.releaseAllLocks(ps, agent.name);
          this.emit({ type: "agent", project: projectId, agent: agent.name });
        }
      }
      const before = ps.locks.length;
      ps.locks = ps.locks.filter((l) => l.expiresAt > now);
      if (ps.locks.length !== before) this.emit({ type: "lock", project: projectId });
    }
  }

  // ---------- Messages ----------

  /**
   * Sends a chat message. With `replyTo` it answers a question: `to` then
   * defaults to the question's author and the answer is stored on the question.
   */
  sendMessage(projectId: string, from: string, to: string | undefined, body: string, replyTo?: number): Message {
    const ps = this.ps(projectId);
    this.agent(projectId, from);
    let question: Message | undefined;
    if (replyTo !== undefined) {
      question = ps.messages.find((m) => m.id === replyTo);
      if (!question || question.kind !== "question") throw new HubError(404, `Question #${replyTo} does not exist`);
    }
    const recipient = to ?? question?.from;
    if (!recipient) throw new HubError(400, 'Missing recipient: pass an agent name or "all"');
    const target = this.resolveRecipient(ps, from, recipient);
    const message = this.pushMessage(ps, {
      from,
      to: target,
      body,
      kind: question ? "answer" : "message",
      replyTo: question?.id,
    });
    if (question && !question.answer) {
      question.answer = { by: from, body, at: message.createdAt, messageId: message.id };
    }
    return message;
  }

  /**
   * Asks a question that should be answered through the hub (never in a local
   * console nobody is watching). Without `to` it goes to whoever most recently
   * asked this agent for something.
   */
  askQuestion(projectId: string, from: string, input: { to?: string; body: string; options?: string[] }): Message {
    const ps = this.ps(projectId);
    this.agent(projectId, from);
    const target = this.resolveRecipient(ps, from, input.to ?? this.defaultAskTarget(ps, from));
    return this.pushMessage(ps, {
      from,
      to: target,
      body: input.body,
      kind: "question",
      options: input.options?.length ? input.options : undefined,
    });
  }

  pendingQuestions(projectId: string): Message[] {
    return this.ps(projectId).messages.filter((m) => m.kind === "question" && !m.answer);
  }

  getMessage(projectId: string, id: number): Message {
    const message = this.ps(projectId).messages.find((m) => m.id === id);
    if (!message) throw new HubError(404, `Message #${id} does not exist`);
    return message;
  }

  private defaultAskTarget(ps: ProjectState, me: string): string {
    for (let i = ps.messages.length - 1; i >= 0; i--) {
      const m = ps.messages[i]!;
      if (m.to === me && m.from !== me && ps.agents[m.from]) return m.from;
    }
    const active = Object.values(ps.tasks).find(
      (t) => t.assignee === me && t.status !== "done" && t.status !== "open" && t.createdBy !== me,
    );
    return active?.createdBy ?? BROADCAST;
  }

  private resolveRecipient(ps: ProjectState, from: string, to: string): string {
    const target = to.toLowerCase() === BROADCAST ? BROADCAST : to;
    if (target !== BROADCAST && !ps.agents[target]) {
      const known = Object.keys(ps.agents).filter((n) => n !== from);
      throw new HubError(
        404,
        `Unknown agent "${to}". Known agents: ${known.length ? known.join(", ") : "(none yet)"}; use "all" to broadcast.`,
      );
    }
    if (target === from) throw new HubError(400, "You cannot send a message to yourself");
    return target;
  }

  private pushMessage(ps: ProjectState, fields: Omit<Message, "id" | "createdAt">): Message {
    const message: Message = { id: ps.nextMessageId++, createdAt: this.now(), ...fields };
    if (message.kind === "message") delete message.kind;
    for (const key of ["options", "replyTo"] as const) if (message[key] === undefined) delete message[key];
    ps.messages.push(message);
    if (ps.messages.length > MAX_MESSAGES_PER_PROJECT) ps.messages.splice(0, ps.messages.length - MAX_MESSAGES_PER_PROJECT);
    this.emit({ type: "message", project: ps.project.id, message });
    return message;
  }

  unread(projectId: string, name: string): Message[] {
    const agent = this.agent(projectId, name);
    return this.ps(projectId).messages.filter(
      (m) => m.id > agent.lastReadId && m.from !== name && (m.to === name || m.to === BROADCAST),
    );
  }

  unreadCount(projectId: string, name: string): number {
    if (!this.projects[projectId]?.agents[name]) return 0;
    return this.unread(projectId, name).length;
  }

  /** Returns unread messages and marks them as read. */
  readMessages(projectId: string, name: string): Message[] {
    const messages = this.unread(projectId, name);
    const last = messages.at(-1);
    if (last) this.agent(projectId, name).lastReadId = last.id;
    return messages;
  }

  recentMessages(projectId: string, limit = 200): Message[] {
    return this.ps(projectId).messages.slice(-limit);
  }

  // ---------- Tasks ----------

  createTask(
    projectId: string,
    by: string,
    input: { title: string; description?: string; assignee?: string },
  ): Task {
    const ps = this.ps(projectId);
    this.agent(projectId, by);
    if (input.assignee && !ps.agents[input.assignee]) throw new HubError(404, `Unknown agent "${input.assignee}"`);
    const now = this.now();
    const task: Task = {
      id: ps.nextTaskId++,
      title: input.title,
      description: input.description ?? "",
      status: "open",
      createdBy: by,
      assignee: input.assignee || undefined,
      notes: [],
      createdAt: now,
      updatedAt: now,
    };
    ps.tasks[task.id] = task;
    this.emit({ type: "task", project: projectId, taskId: task.id });
    if (task.assignee && task.assignee !== by) {
      this.sendMessage(projectId, by, task.assignee, `I assigned you task #${task.id}: ${task.title}. Claim it when you start.`);
    }
    return task;
  }

  listTasks(projectId: string, filter: { status?: string; assignee?: string } = {}): Task[] {
    return Object.values(this.ps(projectId).tasks)
      .filter((t) => (!filter.status || t.status === filter.status) && (!filter.assignee || t.assignee === filter.assignee))
      .sort((a, b) => a.id - b.id);
  }

  getTask(projectId: string, id: number): Task {
    const task = this.ps(projectId).tasks[id];
    if (!task) throw new HubError(404, `Task #${id} does not exist`);
    return task;
  }

  /** Atomic: exactly one agent can take an open task. */
  claimTask(projectId: string, name: string, id: number): Task {
    this.agent(projectId, name);
    const task = this.getTask(projectId, id);
    if (task.status === "done") throw new HubError(409, `Task #${id} is already done`);
    if (task.assignee && task.assignee !== name) {
      throw new HubError(
        409,
        task.status === "open"
          ? `Task #${id} is assigned to ${task.assignee}; ask them or ${task.createdBy} to reassign it`
          : `Task #${id} is already claimed by ${task.assignee} (status: ${task.status})`,
      );
    }
    if (task.assignee === name && task.status !== "open" && task.status !== "blocked") return task;
    task.assignee = name;
    task.status = "claimed";
    task.updatedAt = this.now();
    this.emit({ type: "task", project: projectId, taskId: id });
    return task;
  }

  updateTask(projectId: string, name: string, id: number, patch: TaskPatch): Task {
    const ps = this.ps(projectId);
    this.agent(projectId, name);
    const task = this.getTask(projectId, id);
    const changesOwnership = patch.status !== undefined || patch.assignee !== undefined;
    const isOwner = task.assignee === name || task.createdBy === name;
    if (changesOwnership && task.assignee && !isOwner) {
      throw new HubError(403, `Task #${id} belongs to ${task.assignee}; only they or ${task.createdBy} can change its status`);
    }
    if (patch.assignee !== undefined) {
      if (patch.assignee && !ps.agents[patch.assignee]) throw new HubError(404, `Unknown agent "${patch.assignee}"`);
      task.assignee = patch.assignee || undefined;
    }
    if (patch.status !== undefined) {
      task.status = patch.status;
      if (patch.status === "open" && patch.assignee === undefined) task.assignee = undefined;
      else if (patch.status !== "open" && !task.assignee) task.assignee = name;
    }
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.description !== undefined) task.description = patch.description;
    if (patch.branch !== undefined) task.branch = patch.branch || undefined;
    if (patch.reviewUrl !== undefined) task.reviewUrl = patch.reviewUrl || undefined;
    if (patch.note) task.notes.push({ author: name, text: patch.note, at: this.now() });
    task.updatedAt = this.now();
    this.emit({ type: "task", project: projectId, taskId: id });
    return task;
  }

  // ---------- Locks ----------

  /** All-or-nothing: either every path is locked for `owner` or nothing changes. */
  lockFiles(projectId: string, owner: string, rawPaths: string[], reason = "", ttlMinutes = DEFAULT_LOCK_TTL_MIN): Lock[] {
    const ps = this.ps(projectId);
    this.agent(projectId, owner);
    const now = this.now();
    const paths = [...new Set(rawPaths.map(normalizePath))];
    const live = ps.locks.filter((l) => l.expiresAt > now);
    const conflicts: string[] = [];
    for (const path of paths) {
      for (const lock of live) {
        if (lock.owner !== owner && pathsConflict(path, lock.path)) {
          conflicts.push(`"${path}" overlaps "${lock.path}" locked by ${lock.owner}${lock.reason ? ` (${lock.reason})` : ""}`);
        }
      }
    }
    if (conflicts.length) throw new HubError(409, `Lock conflict:\n- ${conflicts.join("\n- ")}`);

    const expiresAt = now + ttlMinutes * 60_000;
    const result: Lock[] = [];
    for (const path of paths) {
      const mine = live.find((l) => l.owner === owner && samePath(l.path, path));
      if (mine) {
        mine.expiresAt = expiresAt;
        if (reason) mine.reason = reason;
        result.push(mine);
      } else {
        const lock: Lock = { path, owner, reason, createdAt: now, expiresAt };
        live.push(lock);
        result.push(lock);
      }
    }
    ps.locks = live;
    this.emit({ type: "lock", project: projectId });
    return result;
  }

  /** Releases the given paths (or all of the owner's locks). `force` lets a human clear someone else's stale lock. */
  unlockFiles(projectId: string, owner: string, rawPaths?: string[], force = false): Lock[] {
    const ps = this.ps(projectId);
    const paths = rawPaths?.length ? rawPaths.map(normalizePath) : undefined;
    const released: Lock[] = [];
    ps.locks = ps.locks.filter((l) => {
      const pathMatch = !paths || paths.some((p) => samePath(p, l.path));
      const ownerMatch = l.owner === owner || (force && !!paths);
      if (pathMatch && ownerMatch) {
        released.push(l);
        return false;
      }
      return true;
    });
    if (released.length) this.emit({ type: "lock", project: projectId });
    return released;
  }

  listLocks(projectId: string): Lock[] {
    const now = this.now();
    return this.ps(projectId).locks.filter((l) => l.expiresAt > now);
  }

  overview(projectId: string): Overview {
    const ps = this.ps(projectId);
    return {
      project: ps.project,
      agents: this.listAgents(projectId),
      tasks: this.listTasks(projectId),
      locks: this.listLocks(projectId),
      messages: this.recentMessages(projectId),
    };
  }

  // ---------- helpers ----------

  private ps(projectId: string): ProjectState {
    const ps = this.projects[projectId];
    if (!ps) throw new HubError(404, `Project "${projectId}" does not exist`);
    return ps;
  }

  private agent(projectId: string, name: string): Agent {
    const agent = this.ps(projectId).agents[name];
    if (!agent) throw new HubError(404, `Agent "${name}" is not registered in project "${projectId}"`);
    return agent;
  }

  private view(agent: Agent): AgentView {
    const { sessionId: _s, lastReadId: _r, disconnected: _d, ...rest } = agent;
    return { ...rest, online: this.isOnline(agent) };
  }

  private releaseAllLocks(ps: ProjectState, owner: string): void {
    const before = ps.locks.length;
    ps.locks = ps.locks.filter((l) => l.owner !== owner);
    if (ps.locks.length !== before) this.emit({ type: "lock", project: ps.project.id });
  }
}
