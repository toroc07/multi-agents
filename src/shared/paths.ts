/**
 * Lock paths are repo-relative and compared as prefixes: locking "src/api"
 * covers "src/api/users.ts", and "." covers the whole project.
 */

export class PathError extends Error {}

export const ROOT = ".";

export function normalizePath(input: string): string {
  let p = input.trim().replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(p) || p.startsWith("/") || p.startsWith("~")) {
    throw new PathError(`"${input}" is absolute; use a path relative to the project root`);
  }
  if (/[*?[\]{}]/.test(p)) {
    throw new PathError(`"${input}" contains glob characters; lock a file or a folder instead`);
  }
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) throw new PathError(`"${input}" points outside the project`);
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  p = parts.join("/");
  return p === "" ? ROOT : p;
}

/** Case-insensitive so Windows and macOS users never edit the same file under two spellings. */
export function pathsConflict(a: string, b: string): boolean {
  if (a === ROOT || b === ROOT) return true;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(y + "/") || y.startsWith(x + "/");
}

export function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
