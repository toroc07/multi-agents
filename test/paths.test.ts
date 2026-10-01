import { describe, expect, it } from "vitest";
import { normalizePath, PathError, pathsConflict } from "../src/shared/paths.js";

describe("normalizePath", () => {
  it("normalizes separators, dots and trailing slashes", () => {
    expect(normalizePath("src\\api\\users.ts")).toBe("src/api/users.ts");
    expect(normalizePath("./src//api/")).toBe("src/api");
    expect(normalizePath("src/a/../b")).toBe("src/b");
    expect(normalizePath(".")).toBe(".");
    expect(normalizePath("./")).toBe(".");
  });

  it("rejects absolute paths, escapes and globs", () => {
    expect(() => normalizePath("/etc/passwd")).toThrow(PathError);
    expect(() => normalizePath("C:\\repo\\a.ts")).toThrow(PathError);
    expect(() => normalizePath("../outside")).toThrow(PathError);
    expect(() => normalizePath("src/*.ts")).toThrow(PathError);
  });
});

describe("pathsConflict", () => {
  it("treats folders as prefixes", () => {
    expect(pathsConflict("src/api", "src/api/users.ts")).toBe(true);
    expect(pathsConflict("src/api/users.ts", "src/api")).toBe(true);
    expect(pathsConflict("src/api", "src/apiary")).toBe(false);
    expect(pathsConflict("src/a.ts", "src/b.ts")).toBe(false);
  });

  it("root conflicts with everything and comparison ignores case", () => {
    expect(pathsConflict(".", "anything/here")).toBe(true);
    expect(pathsConflict("Src/App.ts", "src/app.ts")).toBe(true);
  });
});
