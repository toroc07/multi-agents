import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/config.js";
import {
  ConfigEditError,
  ensureGitignored,
  upsertJsonEntry,
  upsertMarkedBlock,
  upsertTomlTable,
  writeKeepingEol,
} from "../src/fileEdit.js";
import { runInit } from "../src/init.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "multi-agents-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const read = (rel: string) => readFileSync(join(dir, rel), "utf8");
const hasLoneLf = (text: string) => /(^|[^\r])\n/.test(text);

describe("line endings", () => {
  it("keeps CRLF files CRLF and does not rewrite identical content", () => {
    const file = join(dir, "a.md");
    writeFileSync(file, "one\r\ntwo\r\n");
    expect(writeKeepingEol(file, "one\ntwo\nthree\n")).toBe(true);
    expect(read("a.md")).toBe("one\r\ntwo\r\nthree\r\n");
    expect(writeKeepingEol(file, "one\ntwo\nthree\n")).toBe(false);
  });

  it("updates a marked block in a CRLF file without mixing endings, idempotently", () => {
    const file = join(dir, "AGENTS.md");
    writeFileSync(file, "# Mine\r\n\r\nKeep this.\r\n");
    upsertMarkedBlock(file, "<!-- s -->", "<!-- e -->", "<!-- s -->\nblock v1\n<!-- e -->");
    const first = read("AGENTS.md");
    expect(first).toContain("Keep this.\r\n");
    expect(first).toContain("block v1");
    expect(hasLoneLf(first)).toBe(false);
    upsertMarkedBlock(file, "<!-- s -->", "<!-- e -->", "<!-- s -->\nblock v2\n<!-- e -->");
    expect(read("AGENTS.md")).toBe(first.replace("v1", "v2"));
  });

  it("adds .gitignore entries once, even with a BOM or CRLF", () => {
    writeFileSync(join(dir, ".gitignore"), "﻿.gemini/\r\nnode_modules/\r\n");
    expect(ensureGitignored(dir, ".gemini/")).toBe(false);
    expect(ensureGitignored(dir, ".multi-agents.json")).toBe(true);
    expect(ensureGitignored(dir, ".multi-agents.json")).toBe(false);
    expect(read(".gitignore")).toBe("﻿.gemini/\r\nnode_modules/\r\n.multi-agents.json\r\n");
  });
});

describe("config editors", () => {
  it("merges a JSON entry, keeping other settings, and refuses JSONC", () => {
    const file = join(dir, "opencode.json");
    writeFileSync(file, JSON.stringify({ theme: "dark", mcp: { other: { type: "local" } } }));
    expect(upsertJsonEntry(file, "mcp", "multi-agents", { type: "local", command: ["node"] })).toBe("updated");
    const data = JSON.parse(read("opencode.json"));
    expect(data.theme).toBe("dark");
    expect(Object.keys(data.mcp)).toEqual(["other", "multi-agents"]);
    expect(existsSync(`${file}.bak`)).toBe(true);

    writeFileSync(file, '{ // comment\n "a": 1 }');
    expect(() => upsertJsonEntry(file, "mcp", "x", {})).toThrow(ConfigEditError);
  });

  it("replaces a TOML table and its sub-tables, keeping the rest", () => {
    const before = [
      'model = "gpt-5"',
      "",
      '[mcp_servers."multi-agents"]',
      'command = "old"',
      "",
      "[mcp_servers.multi-agents.env]",
      'TOKEN = "secret"',
      "",
      "[mcp_servers.other]",
      'command = "keep"',
    ].join("\n");
    const after = upsertTomlTable(before, "mcp_servers.multi-agents", 'command = "new"');
    expect(after).toContain('model = "gpt-5"');
    expect(after).toContain('[mcp_servers.other]\ncommand = "keep"');
    expect(after).not.toContain("old");
    expect(after).not.toContain("secret");
    expect(after.trimEnd().endsWith('[mcp_servers.multi-agents]\ncommand = "new"')).toBe(true);
    expect(upsertTomlTable("", "a.b", "x = 1")).toBe("[a.b]\nx = 1\n");
  });
});

describe("init --write", () => {
  const cfg = (): AgentConfig => ({
    hubUrl: "http://127.0.0.1:9",
    token: "secret-token",
    project: "demo",
    agentName: "agent-1",
    agentClient: "unknown",
    waitTimeoutS: 50,
  });

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("writes project configs for OpenCode, Gemini and Cursor without the token", async () => {
    for (const client of ["opencode", "gemini", "cursor"] as const) {
      expect(await runInit(cfg(), client, dir, { write: true, cliPath: "/x/cli.js", home: dir })).toBe(0);
    }
    const oc = JSON.parse(read("opencode.json"));
    expect(oc.mcp["multi-agents"].command).toEqual([process.execPath, "/x/cli.js", "connect", "--config", join(dir, ".multi-agents.json")]);
    const gem = JSON.parse(read(".gemini/settings.json"));
    expect(gem.mcpServers["multi-agents"]).toMatchObject({ command: process.execPath, trust: true });
    expect(JSON.parse(read(".cursor/mcp.json")).mcpServers["multi-agents"].args).toContain("--config");

    for (const f of ["opencode.json", ".gemini/settings.json", ".cursor/mcp.json"]) expect(read(f)).not.toContain("secret-token");
    expect(JSON.parse(read(".multi-agents.json")).token).toBe("secret-token");
    expect(read(".gitignore").split("\n")).toEqual(
      expect.arrayContaining([".multi-agents.json", "opencode.json", ".gemini/settings.json", ".cursor/mcp.json"]),
    );
    expect(read("GEMINI.md")).toBe("@AGENTS.md\n");
    expect(read("AGENTS.md")).toContain("Never ask in your local console");
  });

  it("writes the Codex table into CODEX_HOME/config.toml, keeping other settings", async () => {
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
    vi.stubEnv("CODEX_HOME", codexHome);
    expect(await runInit(cfg(), "codex", dir, { write: true, cliPath: "/x/cli.js" })).toBe(0);
    const toml = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(toml).toContain('model = "gpt-5"');
    expect(toml).toContain("[mcp_servers.multi-agents]");
    expect(toml).toContain('"connect", "--config"');
    expect(toml).not.toContain("secret-token");
    expect(existsSync(join(codexHome, "config.toml.bak"))).toBe(true);
  });

  it("is idempotent on a CRLF checkout", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "# Project rules\r\n\r\nBe nice.\r\n");
    writeFileSync(join(dir, ".gitignore"), "node_modules/\r\n");
    await runInit(cfg(), "opencode", dir, { write: true, cliPath: "/x/cli.js" });
    const agents = read("AGENTS.md");
    const ignore = read(".gitignore");
    expect(hasLoneLf(agents)).toBe(false);
    expect(hasLoneLf(ignore)).toBe(false);
    await runInit(cfg(), "opencode", dir, { write: true, cliPath: "/x/cli.js" });
    expect(read("AGENTS.md")).toBe(agents);
    expect(read(".gitignore")).toBe(ignore);
  });
});
