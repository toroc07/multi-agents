import type { AgentConfig } from "../config.js";
import type {
  AgentKind,
  AgentView,
  Lock,
  Message,
  Overview,
  Project,
  ProjectInput,
  Task,
  TaskPatch,
} from "../shared/types.js";
import type { ProtocolInterface } from "../shared/protocol.js";

export class HubClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export interface HubResponse<T> {
  data: T;
  /** Unread messages for this agent after the call. */
  unread: number;
}

/** Thin HTTP client for the hub, shared by the MCP bridge and the CLI commands. */
export class HubClient {
  constructor(
    readonly config: AgentConfig,
    private readonly identity: { kind: AgentKind; sessionId?: string } = { kind: "cli" },
  ) {}

  private get base(): string {
    return `${this.config.hubUrl}/api/projects/${encodeURIComponent(this.config.project)}`;
  }

  async request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<HubResponse<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.token}`,
      "x-agent": encodeURIComponent(this.config.agentName),
      "x-agent-client": encodeURIComponent(this.config.agentClient),
      "x-agent-kind": this.identity.kind,
    };
    if (this.config.agentModel) headers["x-agent-model"] = encodeURIComponent(this.config.agentModel);
    if (this.identity.sessionId) headers["x-agent-session"] = this.identity.sessionId;
    if (body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new HubClientError(
        `Cannot reach the multi-agents hub at ${this.config.hubUrl} (${(err as Error).message}). ` +
          `Check HUB_URL and that the hub is running.`,
      );
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new HubClientError(`Unexpected response from hub (${res.status}): ${text.slice(0, 200)}`, res.status);
    }
    if (!res.ok) {
      const msg = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
      throw new HubClientError(msg, res.status);
    }
    return { data: data as T, unread: Number(res.headers.get("x-unread-count") ?? 0) };
  }

  // Projects
  listProjects() {
    return this.request<Project[]>("GET", `${this.config.hubUrl}/api/projects`);
  }
  upsertProject(input: ProjectInput) {
    return this.request<Project>("POST", `${this.config.hubUrl}/api/projects`, input);
  }
  getProject(iface: ProtocolInterface = "both") {
    return this.request<{ project: Project; protocol: string }>("GET", `${this.base}?iface=${iface}`);
  }
  overview() {
    return this.request<Overview>("GET", `${this.base}/overview`);
  }

  // Agents
  register() {
    return this.request<{ agent: AgentView; project: Project }>("POST", `${this.base}/agents/register`, {
      client: this.config.agentClient,
      model: this.config.agentModel,
      kind: this.identity.kind,
      sessionId: this.identity.sessionId,
    });
  }
  heartbeat() {
    return this.request<{ ok: boolean; unread: number }>("POST", `${this.base}/agents/heartbeat`);
  }
  disconnect() {
    return this.request<{ ok: boolean }>("POST", `${this.base}/agents/disconnect`);
  }
  updateMe(patch: { status?: string; branch?: string }) {
    return this.request<AgentView>("PATCH", `${this.base}/agents/me`, patch);
  }
  listAgents() {
    return this.request<AgentView[]>("GET", `${this.base}/agents`);
  }

  // Messages
  sendMessage(to: string, body: string) {
    return this.request<Message>("POST", `${this.base}/messages`, { to, body });
  }
  readMessages(peek = false) {
    return this.request<Message[]>("GET", `${this.base}/messages?unread=1${peek ? "&peek=1" : ""}`);
  }
  waitForMessages(timeoutS: number, signal?: AbortSignal) {
    return this.request<Message[]>("GET", `${this.base}/messages/wait?timeout=${Math.round(timeoutS)}`, undefined, signal);
  }

  // Tasks
  listTasks(filter: { status?: string; assignee?: string } = {}) {
    const q = new URLSearchParams();
    if (filter.status) q.set("status", filter.status);
    if (filter.assignee) q.set("assignee", filter.assignee);
    return this.request<Task[]>("GET", `${this.base}/tasks${q.size ? `?${q}` : ""}`);
  }
  getTask(id: number) {
    return this.request<Task>("GET", `${this.base}/tasks/${id}`);
  }
  createTask(input: { title: string; description?: string; assignee?: string }) {
    return this.request<Task>("POST", `${this.base}/tasks`, input);
  }
  claimTask(id: number) {
    return this.request<Task>("POST", `${this.base}/tasks/${id}/claim`);
  }
  updateTask(id: number, patch: TaskPatch) {
    return this.request<Task>("PATCH", `${this.base}/tasks/${id}`, patch);
  }

  // Locks
  listLocks() {
    return this.request<Lock[]>("GET", `${this.base}/locks`);
  }
  lockFiles(paths: string[], reason?: string, ttlMinutes?: number) {
    return this.request<Lock[]>("POST", `${this.base}/locks`, { paths, reason, ttlMinutes });
  }
  unlockFiles(paths?: string[], force?: boolean) {
    return this.request<Lock[]>("POST", `${this.base}/locks/release`, { paths, force });
  }
}
