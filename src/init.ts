import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HubClient } from "./bridge/client.js";
import { CONFIG_FILE, type AgentConfig } from "./config.js";
import { buildProtocol } from "./shared/protocol.js";
import type { Project } from "./shared/types.js";

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

/**
 * Sets up the current project folder for one agent: writes the local
 * .multi-agents.json, the shared AGENTS.md protocol, and prints the MCP
 * config snippet for the chosen client.
 */
export async function runInit(cfg: AgentConfig, client: ClientId, dir: string): Promise<number> {
  const root = resolve(dir);
  // Generic setups keep a custom label (e.g. AGENT_CLIENT=aider); named clients always use their own.
  const generic = client === "cli" || client === "generic-mcp";
  if (!generic || !process.env.AGENT_CLIENT) cfg.agentClient = CLIENT_LABEL[client];
  const say = (line = "") => console.log(line);

  // 1. Local, git-ignored config so CLI commands work from this folder.
  const local = {
    hubUrl: cfg.hubUrl,
    token: cfg.token,
    project: cfg.project,
    agentName: cfg.agentName,
    agentClient: cfg.agentClient,
    ...(cfg.agentModel ? { agentModel: cfg.agentModel } : {}),
  };
  writeFileSync(join(root, CONFIG_FILE), JSON.stringify(local, null, 2) + "\n");
  ensureGitignored(root, CONFIG_FILE);
  say(`✔ Wrote ${CONFIG_FILE} (git-ignored; contains the hub token)`);

  // 2. Shared protocol for every agent working in this folder.
  const project = await fetchProject(cfg);
  if (!project.reachable) {
    say(`⚠ Hub not reachable at ${cfg.hubUrl} (${project.error}); using default project settings for AGENTS.md.`);
  }
  upsertBlock(join(root, "AGENTS.md"), agentsBlock(project.project));
  say(`✔ Updated AGENTS.md with the collaboration protocol (commit this file so every agent sees it)`);
  if (client === "claude-code") addImport(join(root, "CLAUDE.md"), say);
  if (client === "gemini") addImport(join(root, "GEMINI.md"), say);

  // 3. How to plug the bridge into the client.
  say();
  say(snippet(client, cfg));
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
        branchPattern: "agent/{agent}",
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
    `Your agent name, project and hub are configured per machine (MCP env vars or \`${CONFIG_FILE}\`). ` +
      `Check them with \`whoami\` (MCP) or \`multi-agents status\` (CLI). If you have MCP tools named like ` +
      `\`send_message\`/\`claim_task\` from the "multi-agents" server, use them; otherwise use the \`multi-agents\` CLI commands.`,
    END,
  ].join("\n");
}

function upsertBlock(file: string, block: string): void {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  let next: string;
  if (start !== -1 && end > start) {
    next = current.slice(0, start) + block + current.slice(end + END.length);
  } else if (current.trim()) {
    next = current.replace(/\s*$/, "\n\n") + block + "\n";
  } else {
    next = `# AGENTS.md\n\n${block}\n`;
  }
  writeFileSync(file, next);
}

function addImport(file: string, say: (s: string) => void): void {
  const name = file.split(/[\\/]/).pop();
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.includes("AGENTS.md")) return;
  writeFileSync(file, current ? current.replace(/\s*$/, "\n\n@AGENTS.md\n") : "@AGENTS.md\n");
  say(`✔ ${name} now imports AGENTS.md`);
}

function ensureGitignored(root: string, entry: string): void {
  const file = join(root, ".gitignore");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split(/\r?\n/).some((l) => l.trim() === entry || l.trim() === `/${entry}`)) return;
  writeFileSync(file, (current ? current.replace(/\s*$/, "\n") : "") + `${entry}\n`);
}

/** Quotes a value for the user's shell only when needed (PowerShell/cmd on Windows, POSIX elsewhere). */
function shellQuote(value: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(value)) return value;
  return process.platform === "win32" ? `"${value.replace(/"/g, '\\"')}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}

function snippet(client: ClientId, cfg: AgentConfig): string {
  const node = process.execPath;
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const env: Record<string, string> = {
    HUB_URL: cfg.hubUrl,
    MULTI_AGENTS_TOKEN: cfg.token,
    PROJECT: cfg.project,
    AGENT_NAME: cfg.agentName,
    AGENT_CLIENT: cfg.agentClient,
  };
  if (cfg.agentModel) env.AGENT_MODEL = cfg.agentModel;
  const q = JSON.stringify;
  const jsonServer = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ mcpServers: { "multi-agents": { command: node, args: [cli, "connect"], env, ...extra } } }, null, 2);
  const secret = "⚠ This config contains the hub token: keep it out of git.";

  switch (client) {
    case "claude-code":
      return [
        "Run this inside the project folder (adds the MCP server for this project only):",
        "",
        `claude mcp add multi-agents ${Object.entries(env).map(([k, v]) => `-e ${shellQuote(`${k}=${v}`)}`).join(" ")} -- ${shellQuote(node)} ${shellQuote(cli)} connect`,
        "",
        "Then start `claude` here and ask it to follow AGENTS.md (e.g. \"check the board and pick a task\").",
      ].join("\n");
    case "codex":
      return [
        "Add this to ~/.codex/config.toml (use a different server name per project if you join several):",
        "",
        `[mcp_servers.multi-agents]`,
        `command = ${q(node)}`,
        `args = [${q(cli)}, "connect"]`,
        `env = { ${Object.entries(env).map(([k, v]) => `${k} = ${q(v)}`).join(", ")} }`,
        `tool_timeout_sec = 120`,
        "",
        "Codex reads AGENTS.md automatically.",
      ].join("\n");
    case "opencode":
      return [
        "Add this to ~/.config/opencode/opencode.json (or the project's opencode.json if it is git-ignored):",
        "",
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            mcp: { "multi-agents": { type: "local", command: [node, cli, "connect"], enabled: true, environment: env } },
          },
          null,
          2,
        ),
        "",
        "OpenCode reads AGENTS.md automatically. " + secret,
      ].join("\n");
    case "gemini":
      return [
        "Add this to ~/.gemini/settings.json (or .gemini/settings.json if it is git-ignored):",
        "",
        jsonServer({ timeout: 120_000 }),
        "",
        "GEMINI.md imports AGENTS.md. " + secret,
      ].join("\n");
    case "cursor":
      return [
        "Add this to ~/.cursor/mcp.json (or .cursor/mcp.json if it is git-ignored):",
        "",
        jsonServer(),
        "",
        "Cursor reads AGENTS.md automatically. " + secret,
      ].join("\n");
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
        `  multi-agents:`,
        `    type: stdio`,
        `    name: multi-agents`,
        `    enabled: true`,
        `    cmd: ${q(node)}`,
        `    args: [${q(cli)}, "connect"]`,
        `    envs: { ${Object.entries(env).map(([k, v]) => `${k}: ${q(v)}`).join(", ")} }`,
        `    timeout: 300`,
        "",
        "Point goose to AGENTS.md (e.g. mention it in .goosehints).",
      ].join("\n");
    case "generic-mcp":
      return [
        "Generic MCP (stdio) server definition — adapt it to your client's config format:",
        "",
        jsonServer(),
        "",
        secret,
      ].join("\n");
    case "cli":
      return [
        "No MCP needed: from this folder your agent (Aider, scripts, any tool with a shell) can run:",
        "",
        "  multi-agents status            # who am I + project",
        "  multi-agents task list         # board",
        "  multi-agents msg read          # inbox",
        "  multi-agents protocol          # full rules",
        "",
        `If \`multi-agents\` is not on PATH, use: ${shellQuote(node)} ${shellQuote(cli)} <command>`,
        "Tell your agent to read AGENTS.md before starting (e.g. aider --read AGENTS.md).",
      ].join("\n");
  }
}
