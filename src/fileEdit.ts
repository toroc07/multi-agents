import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Small, careful editors for files that `init` touches in the user's project
 * or home folder. They keep the file's line endings (CRLF on Windows checkouts)
 * so git does not see spurious changes, and back up anything they modify.
 */

export function readText(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** Writes `content` (LF) using the existing file's line endings. Returns true if the file changed. */
export function writeKeepingEol(file: string, content: string, existing = readText(file)): boolean {
  const eol = existing?.includes("\r\n") ? "\r\n" : "\n";
  const next = content.replace(/\r\n/g, "\n").replace(/\n/g, eol);
  if (next === existing) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  return true;
}

/** Normalizes to LF for editing; writeKeepingEol restores the original endings. */
export function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function backup(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const bak = `${file}.bak`;
  copyFileSync(file, bak);
  return bak;
}

/** Adds `entry` to the folder's .gitignore unless an equivalent line is there. Returns true if added. */
export function ensureGitignored(root: string, entry: string): boolean {
  const file = join(root, ".gitignore");
  const current = lf(readText(file) ?? "");
  const wanted = entry.replace(/^\//, "");
  if (current.split("\n").some((l) => l.trim().replace(/^\//, "") === wanted)) return false;
  writeKeepingEol(file, (current ? current.replace(/\s*$/, "\n") : "") + `${entry}\n`);
  return true;
}

/** Replaces the text between two marker lines, or appends the block. */
export function upsertMarkedBlock(file: string, start: string, end: string, block: string, header = ""): void {
  const existing = readText(file);
  const current = lf(existing ?? "");
  const from = current.indexOf(start);
  const to = current.indexOf(end);
  let next: string;
  if (from !== -1 && to > from) next = current.slice(0, from) + block + current.slice(to + end.length);
  else if (current.trim()) next = current.replace(/\s*$/, "\n\n") + block + "\n";
  else next = `${header}${block}\n`;
  writeKeepingEol(file, next, existing);
}

export class ConfigEditError extends Error {}

/**
 * Sets `obj[section][key] = value` in a JSON config file, keeping everything
 * else. Refuses to touch files with comments (JSONC) rather than lose them.
 */
export function upsertJsonEntry(file: string, section: string, key: string, value: unknown, base: Record<string, unknown> = {}): "created" | "updated" {
  const existing = readText(file);
  let data: Record<string, unknown> = { ...base };
  if (existing !== undefined && existing.trim()) {
    try {
      data = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      throw new ConfigEditError(`${file} is not plain JSON (comments?); add the entry by hand.`);
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new ConfigEditError(`${file} is not a JSON object`);
  }
  const current = data[section];
  const sectionObj = typeof current === "object" && current !== null && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  sectionObj[key] = value;
  data[section] = sectionObj;
  if (existing !== undefined) backup(file);
  writeKeepingEol(file, JSON.stringify(data, null, 2) + "\n", existing);
  return existing === undefined ? "created" : "updated";
}

/**
 * Replaces the TOML table `[name]` (and its sub-tables `[name.*]`) with
 * `body`, or appends it. Table names are compared ignoring quotes, so
 * `[mcp_servers."multi-agents"]` matches `mcp_servers.multi-agents`.
 */
export function upsertTomlTable(content: string, name: string, body: string): string {
  const lines = lf(content).split("\n");
  const clean = (header: string) => header.replace(/["']/g, "").trim();
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      const table = clean(header[1]!);
      skipping = table === name || table.startsWith(`${name}.`);
    }
    if (!skipping) out.push(line);
  }
  const kept = out.join("\n").replace(/\s*$/, "");
  return `${kept ? `${kept}\n\n` : ""}[${name}]\n${body.replace(/\s*$/, "")}\n`;
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}
