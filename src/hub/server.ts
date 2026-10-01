import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { buildProtocol, type ProtocolInterface } from "../shared/protocol.js";
import { PathError } from "../shared/paths.js";
import {
  AGENT_KINDS,
  BROADCAST,
  agentPatchSchema,
  lockInputSchema,
  messageInputSchema,
  projectInputSchema,
  registerSchema,
  taskInputSchema,
  taskPatchSchema,
  unlockInputSchema,
  type AgentKind,
  type Message,
} from "../shared/types.js";
import { VERSION } from "../version.js";
import { HubError, HubState, type HubEvent, type Identity } from "./state.js";
import { JsonStore } from "./store.js";

export interface HubOptions {
  token: string;
  /** Where to persist state; omit for in-memory only (tests). */
  dataFile?: string;
  sweepIntervalMs?: number;
}

export interface Hub {
  server: Server;
  state: HubState;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;
const MAX_WAIT_S = 300;

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  query: URLSearchParams;
  /** Calling agent (from the X-Agent header), already registered/refreshed. */
  agent?: string;
  project?: string;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

export function createHub(opts: HubOptions): Hub {
  const store = opts.dataFile ? new JsonStore(opts.dataFile) : undefined;
  const sseClients = new Set<{ res: ServerResponse; project?: string }>();
  const waiters = new Map<string, Set<() => void>>();

  const state: HubState = new HubState(store?.load(), {
    onEvent: (event) => {
      store?.schedule(() => state.snapshot());
      if (event.type === "message") wakeWaiters(event.project, event.message);
      broadcastSse(event);
    },
  });

  const tokenHash = sha256(opts.token);
  const dashboardHtml = loadDashboard();

  // ---------- helpers ----------

  function waiterKey(project: string, agent: string): string {
    return `${project}\u0000${agent}`;
  }

  function wakeWaiters(project: string, message: Message): void {
    for (const [key, set] of waiters) {
      const [p, agent] = key.split("\u0000");
      if (p !== project || agent === message.from) continue;
      if (message.to === BROADCAST || message.to === agent) for (const wake of [...set]) wake();
    }
  }

  function broadcastSse(event: HubEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      if (!client.project || client.project === event.project) client.res.write(data);
    }
  }

  function authorized(req: IncomingMessage, query: URLSearchParams): boolean {
    const header = req.headers.authorization;
    const given = header?.startsWith("Bearer ") ? header.slice(7) : query.get("token") ?? "";
    return timingSafeEqual(sha256(given), tokenHash);
  }

  function header(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name];
    const raw = Array.isArray(value) ? value[0] : value;
    return raw ? decodeURIComponent(raw) : undefined;
  }

  function identity(req: IncomingMessage): Identity {
    const kind = header(req, "x-agent-kind");
    return {
      client: header(req, "x-agent-client"),
      model: header(req, "x-agent-model"),
      kind: kind && (AGENT_KINDS as readonly string[]).includes(kind) ? (kind as AgentKind) : undefined,
      sessionId: header(req, "x-agent-session"),
    };
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new HubError(413, "Request body too large");
      chunks.push(chunk as Buffer);
    }
    if (!size) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HubError(400, "Body must be valid JSON");
    }
  }

  async function parse<T extends z.ZodType>(ctx: Ctx, schema: T): Promise<z.infer<T>> {
    const result = schema.safeParse(await readBody(ctx.req));
    if (!result.success) throw new HubError(400, z.prettifyError(result.error));
    return result.data;
  }

  function me(ctx: Ctx): string {
    if (!ctx.agent) throw new HubError(400, "Missing X-Agent header (agent name)");
    return ctx.agent;
  }

  function project(ctx: Ctx): string {
    return ctx.project!;
  }

  function taskId(ctx: Ctx): number {
    const id = Number(ctx.params[1]);
    if (!Number.isInteger(id) || id < 1) throw new HubError(400, "Invalid task id");
    return id;
  }

  // ---------- routes ----------

  const P = "/api/projects/([^/]+)";
  const routes: Route[] = [
    { method: "GET", pattern: /^\/api\/projects$/, handler: () => state.listProjects() },
    {
      method: "POST",
      pattern: /^\/api\/projects$/,
      handler: async (ctx) => state.upsertProject(await parse(ctx, projectInputSchema)),
    },
    {
      method: "GET",
      pattern: new RegExp(`^${P}$`),
      handler: (ctx) => {
        const p = state.getProject(project(ctx));
        const iface = (ctx.query.get("iface") ?? "both") as ProtocolInterface;
        return { project: p, protocol: buildProtocol(p, { agentName: ctx.agent, iface }) };
      },
    },
    { method: "GET", pattern: new RegExp(`^${P}/overview$`), handler: (ctx) => state.overview(project(ctx)) },

    // Agents
    {
      method: "POST",
      pattern: new RegExp(`^${P}/agents/register$`),
      handler: async (ctx) => {
        const body = await parse(ctx, registerSchema);
        const agent = state.identify(project(ctx), me(ctx), body);
        return { agent: state.getAgent(project(ctx), agent.name), project: state.getProject(project(ctx)) };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^${P}/agents/heartbeat$`),
      handler: (ctx) => ({ ok: true, unread: state.unreadCount(project(ctx), me(ctx)) }),
    },
    {
      method: "POST",
      pattern: new RegExp(`^${P}/agents/disconnect$`),
      handler: (ctx) => {
        state.disconnect(project(ctx), me(ctx));
        return { ok: true };
      },
    },
    {
      method: "PATCH",
      pattern: new RegExp(`^${P}/agents/me$`),
      handler: async (ctx) => state.getAgent(project(ctx), state.updateAgent(project(ctx), me(ctx), await parse(ctx, agentPatchSchema)).name),
    },
    { method: "GET", pattern: new RegExp(`^${P}/agents$`), handler: (ctx) => state.listAgents(project(ctx)) },

    // Messages
    {
      method: "POST",
      pattern: new RegExp(`^${P}/messages$`),
      handler: async (ctx) => {
        const body = await parse(ctx, messageInputSchema);
        return state.sendMessage(project(ctx), me(ctx), body.to, body.body);
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^${P}/messages$`),
      handler: (ctx) => {
        if (ctx.query.get("unread") === "1") {
          return ctx.query.get("peek") === "1"
            ? state.unread(project(ctx), me(ctx))
            : state.readMessages(project(ctx), me(ctx));
        }
        return state.recentMessages(project(ctx), Math.min(Number(ctx.query.get("limit")) || 200, 1000));
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^${P}/messages/wait$`),
      handler: async (ctx) => {
        const p = project(ctx);
        const name = me(ctx);
        const first = state.readMessages(p, name);
        if (first.length) return first;
        const timeoutS = Math.min(Math.max(Number(ctx.query.get("timeout")) || 50, 1), MAX_WAIT_S);
        const key = waiterKey(p, name);
        await new Promise<void>((resolve) => {
          const set = waiters.get(key) ?? new Set();
          waiters.set(key, set);
          const done = () => {
            clearTimeout(timer);
            set.delete(done);
            if (!set.size) waiters.delete(key);
            resolve();
          };
          const timer = setTimeout(done, timeoutS * 1000);
          set.add(done);
          ctx.res.on("close", done);
        });
        if (ctx.res.destroyed) return [];
        state.identify(p, name);
        return state.readMessages(p, name);
      },
    },

    // Tasks
    {
      method: "GET",
      pattern: new RegExp(`^${P}/tasks$`),
      handler: (ctx) =>
        state.listTasks(project(ctx), {
          status: ctx.query.get("status") ?? undefined,
          assignee: ctx.query.get("assignee") ?? undefined,
        }),
    },
    {
      method: "POST",
      pattern: new RegExp(`^${P}/tasks$`),
      handler: async (ctx) => state.createTask(project(ctx), me(ctx), await parse(ctx, taskInputSchema)),
    },
    { method: "GET", pattern: new RegExp(`^${P}/tasks/(\\d+)$`), handler: (ctx) => state.getTask(project(ctx), taskId(ctx)) },
    {
      method: "POST",
      pattern: new RegExp(`^${P}/tasks/(\\d+)/claim$`),
      handler: (ctx) => state.claimTask(project(ctx), me(ctx), taskId(ctx)),
    },
    {
      method: "PATCH",
      pattern: new RegExp(`^${P}/tasks/(\\d+)$`),
      handler: async (ctx) => state.updateTask(project(ctx), me(ctx), taskId(ctx), await parse(ctx, taskPatchSchema)),
    },

    // Locks
    { method: "GET", pattern: new RegExp(`^${P}/locks$`), handler: (ctx) => state.listLocks(project(ctx)) },
    {
      method: "POST",
      pattern: new RegExp(`^${P}/locks$`),
      handler: async (ctx) => {
        const body = await parse(ctx, lockInputSchema);
        return state.lockFiles(project(ctx), me(ctx), body.paths, body.reason, body.ttlMinutes);
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^${P}/locks/release$`),
      handler: async (ctx) => {
        const body = await parse(ctx, unlockInputSchema);
        return state.unlockFiles(project(ctx), me(ctx), body.paths, body.force);
      },
    },
  ];

  // ---------- request handling ----------

  function sendJson(res: ServerResponse, status: number, data: unknown, unread?: number): void {
    if (res.headersSent || res.destroyed) return;
    const headers: Record<string, string | number> = { "content-type": "application/json; charset=utf-8" };
    if (unread !== undefined) headers["x-unread-count"] = unread;
    res.writeHead(status, headers);
    res.end(JSON.stringify(data));
  }

  function openSse(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const client = { res, project: query.get("project") ?? undefined };
    sseClients.add(client);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      sseClients.delete(client);
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(dashboardHtml);
      return;
    }
    if (method === "GET" && path === "/api/health") {
      sendJson(res, 200, { ok: true, name: "multi-agents", version: VERSION });
      return;
    }
    if (!path.startsWith("/api/")) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    if (!authorized(req, url.searchParams)) {
      sendJson(res, 401, { error: "Invalid or missing token (MULTI_AGENTS_TOKEN)" });
      return;
    }
    if (method === "GET" && path === "/api/events") {
      openSse(req, res, url.searchParams);
      return;
    }

    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(path);
      if (!match) continue;
      const params = match.slice(1).map((s) => decodeURIComponent(s));
      const ctx: Ctx = { req, res, params, query: url.searchParams };
      try {
        if (path.startsWith("/api/projects/")) {
          ctx.project = params[0];
          const agent = header(req, "x-agent");
          if (agent) {
            state.identify(ctx.project!, agent, identity(req));
            ctx.agent = agent;
          } else if (!state.hasProject(ctx.project!)) {
            throw new HubError(404, `Project "${ctx.project}" does not exist`);
          }
        }
        const data = await route.handler(ctx);
        const unread = ctx.agent && ctx.project ? state.unreadCount(ctx.project, ctx.agent) : undefined;
        sendJson(res, method === "POST" && /\/(tasks|messages)$/.test(path) ? 201 : 200, data ?? null, unread);
      } catch (err) {
        if (err instanceof HubError) sendJson(res, err.status, { error: err.message });
        else if (err instanceof PathError) sendJson(res, 400, { error: err.message });
        else {
          console.error("[hub] unexpected error:", err);
          sendJson(res, 500, { error: "Internal error" });
        }
      }
      return;
    }
    sendJson(res, 404, { error: `No route for ${method} ${path}` });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("[hub] fatal request error:", err);
      sendJson(res, 500, { error: "Internal error" });
    });
  });

  const sweeper = setInterval(() => state.sweep(), opts.sweepIntervalMs ?? 5_000);
  sweeper.unref();

  return {
    server,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweeper);
        for (const set of waiters.values()) for (const wake of [...set]) wake();
        for (const client of sseClients) client.res.end();
        store?.flush();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export async function startHub(opts: { port: number; host: string; token?: string; dataDir: string }): Promise<Hub> {
  const generated = !opts.token;
  const token = opts.token || randomBytes(18).toString("base64url");
  const hub = createHub({ token, dataFile: join(opts.dataDir, "hub-state.json") });
  await new Promise<void>((resolve, reject) => {
    hub.server.once("error", reject);
    hub.server.listen(opts.port, opts.host, resolve);
  });

  const urls = hubUrls(opts.host, opts.port);
  const lines = [
    `multi-agents hub v${VERSION} listening on ${opts.host}:${opts.port}`,
    ``,
    `  Hub URL(s):   ${urls.join("  |  ")}`,
    `  Token:        ${token}${generated ? "   (generated — set MULTI_AGENTS_TOKEN to keep it stable)" : ""}`,
    `  Dashboard:    ${urls[0]}/#token=${encodeURIComponent(token)}`,
    `  State file:   ${join(opts.dataDir, "hub-state.json")}`,
    ``,
    `Share the hub URL and the token with your team (privately). Press Ctrl+C to stop.`,
  ];
  console.log(lines.join("\n"));

  const shutdown = () => {
    console.log("\nStopping hub...");
    void hub.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return hub;
}

function hubUrls(host: string, port: number): string[] {
  if (host !== "0.0.0.0" && host !== "::") return [`http://${host}:${port}`];
  const urls = [`http://localhost:${port}`];
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === "IPv4" && !addr.internal) urls.push(`http://${addr.address}:${port}`);
    }
  }
  return urls;
}

function loadDashboard(): string {
  try {
    return readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");
  } catch {
    return "<!doctype html><title>multi-agents</title><p>Dashboard file missing; run <code>npm run build</code>.</p>";
  }
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
