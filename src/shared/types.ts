import { z } from "zod";

export const WORKFLOWS = ["github", "git", "none"] as const;
export type Workflow = (typeof WORKFLOWS)[number];

export const TASK_STATUSES = ["open", "claimed", "in_progress", "review", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** How an agent talks to the hub. Purely informative except for presence rules. */
export const AGENT_KINDS = ["mcp", "cli", "api", "human"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Recipient that targets every agent in the project. */
export const BROADCAST = "all";

export const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/;

export interface Project {
  id: string;
  name: string;
  workflow: Workflow;
  repoUrl?: string;
  defaultBranch: string;
  /** Branch naming pattern; supports {agent} and {task}. */
  branchPattern: string;
  /** Max tasks an agent may hold in claimed/in_progress at once (0 = unlimited). Missing = 1. */
  maxActiveTasks?: number;
  createdAt: number;
}

export const DEFAULT_BRANCH_PATTERN = "agent/{agent}/task-{task}";
export const DEFAULT_MAX_ACTIVE_TASKS = 1;

/** What the hub observed an agent doing; shown when newer than its manual status. */
export const ACTIVITY_KINDS = ["working", "editing", "in_review", "blocked", "waiting", "asking", "idle"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface AgentActivity {
  kind: ActivityKind;
  at: number;
  taskId?: number;
  title?: string;
  paths?: string[];
  questionId?: number;
  to?: string;
}

export interface Agent {
  name: string;
  client: string;
  model?: string;
  kind: AgentKind;
  /** Free text set by the agent with set_status. */
  status: string;
  statusAt?: number;
  /** Derived by the hub from the agent's actions. */
  activity?: AgentActivity;
  branch?: string;
  sessionId?: string;
  connectedAt: number;
  lastSeen: number;
  /** Highest message id this agent has read. */
  lastReadId: number;
  /** Explicitly disconnected (or swept); presence is otherwise derived from lastSeen. */
  disconnected: boolean;
}

export interface AgentView extends Omit<Agent, "sessionId" | "lastReadId" | "disconnected"> {
  online: boolean;
}

/**
 * "message" is plain chat; a "question" waits for an "answer" that points back
 * to it with replyTo; an "event" is an announcement from the hub itself.
 */
export const MESSAGE_KINDS = ["message", "question", "answer", "event"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface Answer {
  by: string;
  body: string;
  at: number;
  messageId: number;
}

export interface Message {
  id: number;
  from: string;
  /** Agent name or "all". */
  to: string;
  body: string;
  createdAt: number;
  /** Missing on messages stored before v0.2; treat as "message". */
  kind?: MessageKind;
  /** Suggested choices for a question. */
  options?: string[];
  /** Question this message answers. */
  replyTo?: number;
  /** First answer received, stored on the question itself. */
  answer?: Answer;
  /** For events: the agent whose action is announced (it does not receive its own event). */
  actor?: string;
}

export const LOG_TYPES = [
  "agent.connected",
  "agent.disconnected",
  "agent.removed",
  "task.created",
  "task.claimed",
  "task.status",
  "task.assigned",
  "lock.acquired",
  "lock.released",
  "lock.conflict",
  "question.asked",
  "question.answered",
] as const;
export type LogType = (typeof LOG_TYPES)[number];

/** One line of the project's activity history (shown on the dashboard). */
export interface LogEntry {
  id: number;
  at: number;
  actor: string;
  type: LogType;
  taskId?: number;
  title?: string;
  status?: TaskStatus;
  previous?: TaskStatus;
  /** Assignee, question recipient, or lock holder depending on the type. */
  target?: string;
  paths?: string[];
  questionId?: number;
  /** Why a lock was released or an agent disconnected. */
  reason?: "manual" | "forced" | "disconnect" | "timeout" | "expired" | "closed";
}

export interface TaskNote {
  author: string;
  text: string;
  at: number;
}

export interface Task {
  id: number;
  title: string;
  description: string;
  status: TaskStatus;
  createdBy: string;
  assignee?: string;
  branch?: string;
  reviewUrl?: string;
  notes: TaskNote[];
  createdAt: number;
  updatedAt: number;
}

export interface Lock {
  /** Normalized, repo-relative path ("." = whole project). */
  path: string;
  owner: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
}

export interface Overview {
  project: Project;
  agents: AgentView[];
  tasks: Task[];
  locks: Lock[];
  messages: Message[];
  log: LogEntry[];
}

// ---------- Request schemas (validated by the hub) ----------

export const projectInputSchema = z.object({
  id: z.string().regex(ID_RE, "invalid project id (letters, digits, . _ -)"),
  name: z.string().min(1).max(100).optional(),
  workflow: z.enum(WORKFLOWS).optional(),
  repoUrl: z.string().max(500).optional(),
  defaultBranch: z.string().min(1).max(100).optional(),
  branchPattern: z.string().min(1).max(100).optional(),
  maxActiveTasks: z.number().int().min(0).max(50).optional(),
});
export type ProjectInput = z.infer<typeof projectInputSchema>;

export const registerSchema = z.object({
  client: z.string().min(1).max(60).optional(),
  model: z.string().max(100).optional(),
  kind: z.enum(AGENT_KINDS).optional(),
  sessionId: z.string().max(100).optional(),
});

export const agentPatchSchema = z.object({
  status: z.string().max(300).optional(),
  branch: z.string().max(200).optional(),
});

export const messageInputSchema = z.object({
  /** Optional when replying: defaults to the question's author. */
  to: z.string().min(1).max(40).optional(),
  body: z.string().min(1).max(20_000),
  replyTo: z.number().int().positive().optional(),
});

export const questionInputSchema = z.object({
  /** Who should answer; defaults to whoever most recently asked this agent for something. */
  to: z.string().min(1).max(40).optional(),
  body: z.string().min(1).max(5_000),
  options: z.array(z.string().min(1).max(200)).max(10).optional(),
});
export type QuestionInput = z.infer<typeof questionInputSchema>;

export const taskInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).optional(),
  assignee: z.string().max(40).optional(),
});

export const taskPatchSchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  note: z.string().max(5_000).optional(),
  branch: z.string().max(200).optional(),
  reviewUrl: z.string().max(500).optional(),
  assignee: z.string().max(40).optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
});
export type TaskPatch = z.infer<typeof taskPatchSchema>;

export const lockInputSchema = z.object({
  paths: z.array(z.string().min(1).max(500)).min(1).max(100),
  reason: z.string().max(300).optional(),
  ttlMinutes: z.number().positive().max(24 * 60).optional(),
});

export const unlockInputSchema = z.object({
  paths: z.array(z.string().min(1).max(500)).max(100).optional(),
  force: z.boolean().optional(),
});
