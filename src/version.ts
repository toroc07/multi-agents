import { readFileSync } from "node:fs";

// Works from both src/ (tests) and dist/ (built CLI): package.json is one level up.
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version);
  } catch {
    return "0.0.0";
  }
})();
