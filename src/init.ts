import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HubClient } from "./bridge/client.js";
import { CONFIG_FILE, type AgentConfig } from "./config.js";
import {
  ConfigEditError,
  backup,
  ensureGitignored,
  readText,
  tomlString,
  upsertJsonEntry,
  upsertMarkedBlock,
  upsertTomlTable,
  writeKeepingEol,
  lf,
} from "./fileEdit.js";
import { buildProtocol } from "./shared/protocol.js";
import { DEFAULT_BRANCH_PATTERN, DEFAULT_MAX_ACTIVE_TASKS, type Project } from "./shared/types.js";

export const CLIENTS = ["claude-code", "codex", "opencode", "gemini", "cursor", "cline", "goose", "generic-mcp", "cli"] as const;
export type ClientId = (typeof CLIENTS)[number];

const CLIENT_LABEL: Record<ClientId, string> = {
  "claude-code": "claude-code",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini-cli",
  cursor: "cursor",
  cline: "cline",
  goose: "goose",
  "generic-mcp": "mcp",
  cli: "cli",
};

const START = "<!-- multi-agents:start -->";
const END = "<!-- multi-agents:end -->";
const SERVER = "multi-agents";

/** How every client launches the bridge. No secrets: the token stays in .multi-agents.json. */
export interface Launch {
  command: string;
  args: string[];
}

export interface InitOptions {
  write?: boolean;
  /** Overrides for tests. */
  home?: string;
  cliPath?: string;
}

/**
 * Sets up a project folder for one agent: writes the local .multi-agents.json,
 * the shared AGENTS.md protocol, and the client's MCP config (printed, or
 * written directly with --write).
 */
export async function runInit(cfg: AgentConfig, client: ClientId, root: string, opts: InitOptions = {}): Promise<number> {
  // Generic setups keep a custom label (e.g. AGENT_CLIENT=aider); named clients always use their own.
  const generic = client === "cli" || client === "generic-mcp";
  if (!generic || !process.env.AGENT_CLIENT) cfg.agentClient = CLIENT_LABEL[client];
  const say = (line = "") => console.log(line);

  // 1. Local, git-ignored config: the only place the token is stored.
  const configPath = join(root, CONFIG_FILE);
  const local = {
    hubUrl: cfg.hubUrl,
    token: cfg.token,
    project: cfg.project,
    agentName: cfg.agentName,
    agentClient: cfg.agentClient,
    ...(cfg.agentModel ? { agentModel: cfg.agentModel } : {}),
  };
  writeKeepingEol(configPath, JSON.stringify(local, null, 2) + "\n");
  ensureGitignored(root, CONFIG_FILE);
  say(`✔ Wrote ${CONFIG_FILE} (git-ignored; the only file that holds the hub token)`);

  // 2. Shared protocol for every agent working in this folder.
  const project = await fetchProject(cfg);
  if (!project.reachable) {
    say(`⚠ Hub not reachable at ${cfg.hubUrl} (${project.error}); using default project settings for AGENTS.md.`);
  }
  upsertMarkedBlock(join(root, "AGENTS.md"), START, END, agentsBlock(project.project), "# AGENTS.md\n\n");
  say(`✔ Updated AGENTS.md with the collaboration protocol (commit this file so every agent sees it)`);
  if (client === "claude-code") addImport(join(root, "CLAUDE.md"), say);
  if (client === "gemini") addImport(join(root, "GEMINI.md"), say);

  // 3. Plug the bridge into the client.
  const launch: Launch = {
    command: process.execPath,
    args: [opts.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url)), "connect", "--config", configPath],
  };
  say();
  if (opts.write && WRITERS[client]) {
    try {
      for (const line of WRITERS[client]!(launch, root, opts.home ?? homedir())) say(`✔ ${line}`);
    } catch (err) {
      say(`✖ Could not write the ${client} config: ${(err as Error).message}`);
      say("  Add it by hand instead:");
      say();
      say(snippet(client, launch));
      return 1;
    }
  } else {
    if (opts.write) say(`(--write is not supported for ${client}; add the config by hand)`);
    say(snippet(client, launch));
  }
  say();
  say(`Agent "${cfg.agentName}" · project "${cfg.project}" · hub ${cfg.hubUrl}`);
  if (!cfg.token) say("⚠ No token set. Pass --token or set MULTI_AGENTS_TOKEN, then run init again.");
  return 0;
}

async function fetchProject(cfg: AgentConfig): Promise<{ project: Project; reachable: boolean; error?: string }> {
  try {
    const { data } = await new HubClient(cfg, { kind: "cli" }).getProject("both");
    return { project: data.project, reachable: true };
  } catch (err) {
    return {
      reachable: false,
      error: (err as Error).message,
      project: {
        id: cfg.project,
        name: cfg.project,
        workflow: "github",
        defaultBranch: "main",
        branchPattern: DEFAULT_BRANCH_PATTERN,
        maxActiveTasks: DEFAULT_MAX_ACTIVE_TASKS,
        createdAt: Date.now(),
      },
    };
  }
}

function agentsBlock(project: Project): string {
  const protocol = buildProtocol(project, { iface: "both" }).replace(/^# .*\n/, "");
  return [
    START,
    `## Multi-agent collaboration (multi-agents hub)`,
    protocol.replace(/^## /gm, "### "),
    ``,
    `### Your identity`,
    `Your agent name, project and hub are configured per machine in \`${CONFIG_FILE}\` (git-ignored). ` +
      `Check them with \`whoami\` (MCP) or \`multi-agents status\` (CLI). If you have MCP tools named like ` +
      `\`send_message\`/\`claim_task\` from the "multi-agents" server, use them; otherwise use the \`multi-agents\` CLI commands.`,
    END,
  ].join("\n");
}

function addImport(file: string, say: (s: string) => void): void {
  const existing = readText(file);
  const current = lf(existing ?? "");
  if (current.includes("AGENTS.md")) return;
  writeKeepingEol(file, current ? current.replace(/\s*$/, "\n\n@AGENTS.md\n") : "@AGENTS.md\n", existing);
  say(`✔ ${file.split(/[\\/]/).pop()} now imports AGENTS.md`);
}

// ---------- --write: one writer per client that has a known config location ----------

type Writer = (launch: Launch, root: string, home: string) => string[];

/** Project-level config files only get git-ignored when init created them (an existing tracked file is the user's call). */
function projectJson(root: string, rel: string, section: string, entry: unknown, base?: Record<string, unknown>): string[] {
  const file = join(root, rel);
  const result = upsertJsonEntry(file, section, SERVER, entry, base);
  const lines = [`${result === "created" ? "Created" : "Updated"} ${rel} (no secrets; it only points to ${CONFIG_FILE})`];
  if (result === "created" && ensureGitignored(root, rel.replace(/\\/g, "/"))) lines.push(`Added ${rel} to .gitignore (it holds a path of this machine)`);
  if (result === "updated") lines.push(`Backup of the previous file: ${rel}.bak`);
  return lines;
}

const WRITERS: Partial<Record<ClientId, Writer>> = {
  "claude-code": (launch, root) => {
    run("claude", ["mcp", "remove", SERVER, "--scope", "local"], root, true);
    run("claude", ["mcp", "add", SERVER, "--scope", "local", "--", launch.command, ...launch.args], root);
    return [`Added the "${SERVER}" MCP server to Claude Code for this folder (claude mcp add --scope local)`];
  },
  codex: (launch, _root, home) => {
    const file = join(process.env.CODEX_HOME ?? join(home, ".codex"), "config.toml");
    const existing = readText(file);
    const body = [
      `command = ${tomlString(launch.command)}`,
      `args = [${launch.args.map(tomlString).join(", ")}]`,
      `tool_timeout_sec = 120`,
    ].join("\n");
    if (existing !== undefined) backup(file);
    writeKeepingEol(file, upsertTomlTable(existing ?? "", `mcp_servers.${SERVER}`, body), existing);
    return [
      `Wrote [mcp_servers.${SERVER}] in ${file}${existing !== undefined ? ` (backup: ${file}.bak)` : ""}`,
      `Note: Codex config is global; running init in another project points Codex to that project instead.`,
    ];
  },
  opencode: (launch, root) =>
    projectJson(root, "opencode.json", "mcp", { type: "local", command: [launch.command, ...launch.args], enabled: true }, {
      $schema: "https://opencode.ai/config.json",
    }),
  gemini: (launch, root) => [
    ...projectJson(root, join(".gemini", "settings.json"), "mcpServers", { ...launch, timeout: 120_000, trust: true }),
    `Gemini only reads .gemini/settings.json in trusted folders: accept "trust this folder" when it asks.`,
  ],
  cursor: (launch, root) => projectJson(root, join(".cursor", "mcp.json"), "mcpServers", launch),
};

/**
 * Runs a CLI without a shell, so no argument is ever interpreted by one. On
 * Windows that only finds real executables (e.g. claude.exe from the native
 * installer); an npm .cmd shim is reported instead, and the caller prints the
 * command for the user to run.
 */
function run(command: string, args: string[], cwd: string, ignoreErrors = false): void {
  const res = spawnSync(command, args, { cwd, encoding: "utf8", shell: false });
  if (ignoreErrors) return;
  if ((res.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    throw new ConfigEditError(
      `"${command}" was not found as an executable on PATH` +
        (process.platform === "win32" ? " (npm-installed .cmd shims cannot be run without a shell)" : "") +
        ". Run the command below yourself",
    );
  }
  if (res.error) throw new ConfigEditError(`could not run "${command}": ${res.error.message}`);
  if (res.status !== 0) throw new ConfigEditError(`"${command} ${args.slice(0, 2).join(" ")}" failed: ${(res.stderr || res.stdout).trim()}`);
}

// ---------- printed snippets (no --write, or unsupported clients) ----------

/** Quotes a value for the user's shell only when needed (PowerShell/cmd on Windows, POSIX elsewhere). */
function shellQuote(value: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(value)) return value;
  return process.platform === "win32" ? `"${value.replace(/"/g, '\\"')}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function snippet(client: ClientId, launch: Launch): string {
  const q = JSON.stringify;
  const cmdLine = [launch.command, ...launch.args].map(shellQuote).join(" ");
  const jsonServer = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ mcpServers: { [SERVER]: { ...launch, ...extra } } }, null, 2);
  const tip = "Tip: `multi-agents init ... --write` does this for you.";

  switch (client) {
    case "claude-code":
      return [
        "Run this inside the project folder (adds the MCP server for this folder only):",
        "",
        `claude mcp add ${SERVER} --scope local -- ${cmdLine}`,
        "",
        tip,
        "Then start `claude` here and ask it to follow AGENTS.md (e.g. \"check the board and pick a task\").",
      ].join("\n");
    case "codex":
      return [
        "Add this to ~/.codex/config.toml:",
        "",
        `[mcp_servers.${SERVER}]`,
        `command = ${q(launch.command)}`,
        `args = [${launch.args.map((a) => q(a)).join(", ")}]`,
        `tool_timeout_sec = 120`,
        "",
        tip,
        "Codex reads AGENTS.md automatically.",
      ].join("\n");
    case "opencode":
      return [
        "Add this to the project's opencode.json (or ~/.config/opencode/opencode.json):",
        "",
        JSON.stringify(
          { $schema: "https://opencode.ai/config.json", mcp: { [SERVER]: { type: "local", command: [launch.command, ...launch.args], enabled: true } } },
          null,
          2,
        ),
        "",
        tip,
        "OpenCode reads AGENTS.md automatically.",
      ].join("\n");
    case "gemini":
      return ["Add this to .gemini/settings.json in the project:", "", jsonServer({ timeout: 120_000, trust: true }), "", tip, "GEMINI.md imports AGENTS.md."].join("\n");
    case "cursor":
      return ["Add this to .cursor/mcp.json in the project:", "", jsonServer(), "", tip, "Cursor reads AGENTS.md automatically."].join("\n");
    case "cline":
      return [
        "In Cline: MCP Servers → Configure → add to cline_mcp_settings.json:",
        "",
        jsonServer({ disabled: false, timeout: 120 }),
        "",
        "Tell Cline to read and follow AGENTS.md (or copy it into .clinerules).",
      ].join("\n");
    case "goose":
      return [
        "Add this under `extensions:` in ~/.config/goose/config.yaml:",
        "",
        `  ${SERVER}:`,
        `    type: stdio`,
        `    name: ${SERVER}`,
        `    enabled: true`,
        `    cmd: ${q(launch.command)}`,
        `    args: [${launch.args.map((a) => q(a)).join(", ")}]`,
        `    timeout: 300`,
        "",
        "Point goose to AGENTS.md (e.g. mention it in .goosehints).",
      ].join("\n");
    case "generic-mcp":
      return ["Generic MCP (stdio) server definition — adapt it to your client's config format:", "", jsonServer()].join("\n");
    case "cli":
      return [
        "No MCP needed: from this folder your agent (Aider, scripts, any tool with a shell) can run:",
        "",
        "  multi-agents status            # who am I + project",
        "  multi-agents task list         # board",
        "  multi-agents msg read          # inbox",
        "  multi-agents protocol          # full rules",
        "",
        `If \`multi-agents\` is not on PATH, use: ${[launch.command, launch.args[0]!].map(shellQuote).join(" ")} <command>`,
        "Tell your agent to read AGENTS.md before starting (e.g. aider --read AGENTS.md).",
      ].join("\n");
  }
}
