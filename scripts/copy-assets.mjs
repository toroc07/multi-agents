// Copies non-TypeScript assets (the dashboard HTML) into dist/ after tsc.
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/hub", { recursive: true });
cpSync("src/hub/dashboard.html", "dist/hub/dashboard.html");
