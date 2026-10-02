#!/usr/bin/env node
import { parseArgs } from "node:util";
import { HubClientError } from "./bridge/client.js";
import { runAgentCommand, UsageError, type Opts } from "./bridge/commands.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_FILE, loadConfig, type AgentConfig } from "./config.js";
import { VERSION } from "./version.js";

const HELP = `multi-agents v${VERSION} — let any AI coding agents collaborate across machines

HUB (run once, on the host machine)
  multi-agents hub [--port 7777] [--host 0.0.0.0] [--token T] [--data-dir ./data]
  multi-agents project create <id> [--name N] [--workflow github|git|none] [--repo URL]
                                   [--default-branch main] [--branch-pattern "agent/{agent}/task-{task}"]
                                   [--max-active-tasks 1]   (0 = unlimited)
  multi-agents project list | project show | project update <id> [...same flags]

AGENT SETUP (each machine, inside the project folder)
  multi-agents init --client <claude-code|codex|opencode|gemini|cursor|cline|goose|generic-mcp|cli>
                    --name <agent-name> --hub <url> --token <token> [--project id] [--model M] [--write]
                    --write  also writes the MCP config into the client (Claude Code, Codex, OpenCode, Gemini, Cursor)
  multi-agents connect [--config path/.multi-agents.json]
                                  run the MCP bridge over stdio (used by MCP clients)

AGENT COMMANDS (for agents without MCP, or humans)
  multi-agents status ["what I'm doing"] [--branch B]
  multi-agents agents
  multi-agents msg send <agent|all> "<text>"  |  msg read [--peek]  |  msg wait [--timeout S]
  multi-agents msg send --reply-to <question-id> "<answer>"
  multi-agents ask "<question>" [--options "A|B|C"] [--to name] [--timeout S]
                                  ask through the hub and wait for the answer
  multi-agents task list [--status S] [--mine]  |  task show <id>
  multi-agents task create "<title>" [--desc D] [--assign agent]
  multi-agents task claim <id>
  multi-agents task update <id> [--status S] [--note N] [--branch B] [--review-url U] [--assign A]
  multi-agents lock <paths...> [--reason R] [--ttl minutes]  |  unlock [paths...] [--force]  |  locks
  multi-agents protocol           print the collaboration rules for this project

GLOBAL FLAGS  --config FILE  --hub URL  --token T  --project ID  --name AGENT  --client C  --model M  --json
ENV VARS      HUB_URL  MULTI_AGENTS_TOKEN  PROJECT  AGENT_NAME  AGENT_CLIENT  AGENT_MODEL  WAIT_TIMEOUT_S
              MULTI_AGENTS_CONFIG (path to a config file)
              Without --config, the nearest .multi-agents.json (created by \`init\`) above the current folder is used.

Docs: https://github.com/toroc07/multi-agents`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      json: { type: "boolean" },
      // connection / identity
      hub: { type: "string" },
      token: { type: "string" },
      project: { type: "string" },
      name: { type: "string" },
      client: { type: "string" },
      model: { type: "string" },
      // hub
      port: { type: "string" },
      host: { type: "string" },
      "data-dir": { type: "string" },
      // project
      workflow: { type: "string" },
      repo: { type: "string" },
      "default-branch": { type: "string" },
      "branch-pattern": { type: "string" },
      "max-active-tasks": { type: "string" },
      config: { type: "string" },
      // init
      dir: { type: "string" },
      write: { type: "boolean" },
      // agent commands
      branch: { type: "string" },
      timeout: { type: "string" },
      peek: { type: "boolean" },
      status: { type: "string" },
      mine: { type: "boolean" },
      desc: { type: "string" },
      assign: { type: "string" },
      note: { type: "string" },
      "review-url": { type: "string" },
      reason: { type: "string" },
      ttl: { type: "string" },
      force: { type: "boolean" },
      to: { type: "string" },
      options: { type: "string" },
      "reply-to": { type: "string" },
    },
  });

  const [command, ...args] = positionals;
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (!command || values.help || command === "help") {
    console.log(HELP);
    return 0;
  }

  if (command === "hub") {
    const { startHub } = await import("./hub/server.js");
    await startHub({
      port: Number(values.port ?? process.env.PORT ?? 7777),
      host: values.host ?? process.env.HOST ?? "0.0.0.0",
      token: values.token ?? process.env.MULTI_AGENTS_TOKEN,
      dataDir: values["data-dir"] ?? process.env.MULTI_AGENTS_DATA_DIR ?? "data",
    });
    return -1; // keep running
  }

  const overrides: Partial<AgentConfig> = {};
  if (values.hub) overrides.hubUrl = values.hub;
  if (values.token) overrides.token = values.token;
  if (values.project) overrides.project = values.project;
  if (values.name) overrides.agentName = values.name;
  if (values.client) overrides.agentClient = values.client;
  if (values.model) overrides.agentModel = values.model;

  if (command === "connect") {
    const { runMcpBridge } = await import("./bridge/mcp.js");
    await runMcpBridge(overrides, values.config);
    return -1; // the MCP transport keeps the process alive
  }

  if (command === "init") {
    const { CLIENTS, runInit } = await import("./init.js");
    const client = values.client ?? "";
    if (!(CLIENTS as readonly string[]).includes(client)) {
      throw new UsageError(`init needs --client <${CLIENTS.join("|")}>`);
    }
    if (!values.name && !process.env.AGENT_NAME) throw new UsageError("init needs --name <agent-name> (unique per agent)");
    delete overrides.agentClient;
    // Only the target folder's own config counts (never one found further up the tree).
    const dir = resolve(values.dir ?? process.cwd());
    const own = join(dir, CONFIG_FILE);
    const cfg = loadConfig(overrides, existsSync(own) ? own : false);
    return runInit(cfg, client as (typeof CLIENTS)[number], dir, { write: values.write === true });
  }

  return runAgentCommand(loadConfig(overrides, values.config), command, args, values as Opts);
}

main().then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof UsageError || err instanceof HubClientError) {
      console.error(`Error: ${err.message}`);
    } else if (err instanceof TypeError && (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      console.error(`Error: ${err.message}\nRun: multi-agents help`);
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  },
);
