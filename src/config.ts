import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hostname } from "node:os";

/** Per-machine settings for an agent. Read from env vars, falling back to the nearest .multi-agents.json. */
export interface AgentConfig {
  hubUrl: string;
  token: string;
  project: string;
  agentName: string;
  agentClient: string;
  agentModel?: string;
  waitTimeoutS: number;
}

export const CONFIG_FILE = ".multi-agents.json";
export const DEFAULT_HUB_URL = "http://localhost:7777";
export const DEFAULT_PROJECT = "default";
export const DEFAULT_WAIT_TIMEOUT_S = 50;

type FileConfig = Partial<Omit<AgentConfig, "waitTimeoutS">> & { waitTimeoutS?: number };

export function findConfigFile(start = process.cwd()): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readFileConfig(): FileConfig {
  const file = findConfigFile();
  if (!file) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as FileConfig;
  } catch (err) {
    throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
  }
}

export function loadConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const file = readFileConfig();
  const env = process.env;
  const wait = Number(overrides.waitTimeoutS ?? env.WAIT_TIMEOUT_S ?? file.waitTimeoutS ?? DEFAULT_WAIT_TIMEOUT_S);
  return {
    hubUrl: (overrides.hubUrl ?? env.HUB_URL ?? file.hubUrl ?? DEFAULT_HUB_URL).replace(/\/+$/, ""),
    token: overrides.token ?? env.MULTI_AGENTS_TOKEN ?? file.token ?? "",
    project: overrides.project ?? env.PROJECT ?? env.MULTI_AGENTS_PROJECT ?? file.project ?? DEFAULT_PROJECT,
    agentName: overrides.agentName ?? env.AGENT_NAME ?? file.agentName ?? defaultAgentName(),
    agentClient: overrides.agentClient ?? env.AGENT_CLIENT ?? file.agentClient ?? "unknown",
    agentModel: overrides.agentModel ?? env.AGENT_MODEL ?? file.agentModel,
    waitTimeoutS: Number.isFinite(wait) && wait > 0 ? wait : DEFAULT_WAIT_TIMEOUT_S,
  };
}

function defaultAgentName(): string {
  const host = hostname().toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "");
  return (host || "agent").slice(0, 40);
}
