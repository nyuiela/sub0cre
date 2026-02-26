/**
 * CRE Simulate Gateway: HTTP server that receives JSON payloads and runs
 * `cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @file`.
 * Use when CRE is not deployed: backend sets CRE_HTTP_URL to this container and gets
 * the same interaction as with a deployed workflow (createAgentKey, createMarketsFromBackend, etc.).
 *
 * Auth: set CRE_API_KEY (from cre.chain.link → Organization → APIs) at runtime so the CLI is logged in.
 * All simulate stdout/stderr (including workflow runtime.log) are logged to the gateway console.
 */

import fs from "fs";

const PORT = Number(process.env.PORT ?? "8080");
const CRE_TARGET = process.env.CRE_TARGET ?? "staging-settings";
const WORKFLOW_DIR = "markets";
const RESULT_PREFIX = "Workflow Simulation Result:";

function log(msg: string, meta?: Record<string, unknown>): void {
  const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
  console.log(`[gateway] ${new Date().toISOString()} ${line}`);
}

interface GatewayResponse {
  ok: boolean;
  result?: string;
  raw?: string;
  error?: string;
  exitCode?: number;
}

function parseSimulateOutput(stdout: string, stderr: string): { result: string; raw: string } {
  const raw = [stdout, stderr].filter(Boolean).join("\n");
  const idx = stdout.indexOf(RESULT_PREFIX);
  let result = idx >= 0 ? stdout.slice(idx + RESULT_PREFIX.length).trim() : raw;
  const firstBrace = result.indexOf("{");
  const lastBrace = result.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    result = result.slice(firstBrace, lastBrace + 1);
  }
  return { result, raw };
}

/** Env var names that secrets.yaml uses for simulation. CRE CLI loads these from .env in cwd. */
const SECRET_ENV_KEYS = ["BACKEND_API_KEY", "BACKEND_SIGNER_PRIVATE_KEY", "HTTP_API_KEY", "CRE_ETH_PRIVATE_KEY", "CRE_API_KEY"];

/** Write a .env in cwd with secret-related vars from process.env so CRE CLI can load them during simulate. */
function ensureEnvFileForCre(): void {
  const cwd = process.cwd();
  const lines: string[] = [];
  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key];
    if (value != null && String(value).trim() !== "") {
      const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      lines.push(`${key}="${escaped}"`);
    }
  }
  if (lines.length === 0) return;
  const envPath = `${cwd}/.env`;
  try {
    fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf8");
  } catch {
    /* ignore if unwritable */
  }
}

async function runSimulate(
  payloadPath: string,
  broadcast: boolean
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  ensureEnvFileForCre();

  const args = [
    "workflow",
    "simulate",
    WORKFLOW_DIR,
    "--non-interactive",
    "--trigger-index",
    "1",
    "--http-payload",
    `@${payloadPath}`,
    "--target",
    CRE_TARGET,
  ];
  if (broadcast) args.push("--broadcast");

  const proc = Bun.spawn(["cre", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CRE_TARGET },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  console.log("[gateway] --- cre workflow simulate output (exitCode=%d) ---", exitCode);
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
  console.log("[gateway] --- end cre output ---");

  return { stdout, stderr, exitCode };
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      log("GET", { path: url.pathname, status: 200 });
      return new Response(JSON.stringify({ status: "ok", service: "cre-simulate-gateway" }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    }

    if (req.method === "POST" && (url.pathname === "/" || url.pathname === "/trigger")) {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        log("POST invalid JSON", { path: url.pathname, status: 400 });
        const res: GatewayResponse = { ok: false, error: "Invalid JSON body" };
        return Response.json(res, { status: 400 });
      }

      const action =
        typeof body === "object" && body !== null && "action" in body
          ? (body as { action?: string }).action
          : undefined;
      const broadcastFlag = (body as { broadcast?: boolean })?.broadcast === true;
      log("POST request", { path: url.pathname, action, broadcast: broadcastFlag });
      if (action === "createMarketsFromBackend" && !broadcastFlag) {
        console.log("[gateway] createMarketsFromBackend without broadcast: no real chain write; set body.broadcast=true or CRE_MARKET_CRON_BROADCAST=true for live txs.");
      }

      const payload =
        typeof body === "object" && body !== null ? JSON.stringify(body) : String(body);
      const broadcast =
        typeof body === "object" &&
        body !== null &&
        "broadcast" in body &&
        (body as { broadcast?: boolean }).broadcast === true;

      const tmpPath = `/tmp/cre-payload-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
      await Bun.write(tmpPath, payload);

      try {
        const { stdout, stderr, exitCode } = await runSimulate(tmpPath, broadcast);
        try {
          const f = await import("fs/promises");
          await f.unlink(tmpPath);
        } catch {
          /* ignore */
        }

        const { result, raw } = parseSimulateOutput(stdout, stderr);
        if (exitCode !== 0) {
          log("POST simulate failed", { action, exitCode, resultPreview: result.slice(0, 200) });
          const errResponse: GatewayResponse = {
            ok: false,
            result,
            raw: raw.slice(0, 4096),
            exitCode,
            error: stderr.slice(0, 1024),
          };
          return Response.json(errResponse, { status: 502 });
        }
        log("POST simulate ok", { action, status: 200 });
        try {
          const parsed = JSON.parse(result) as Record<string, unknown>;
          return Response.json(parsed, { status: 200 });
        } catch {
          return Response.json(
            { ok: true, result, raw: raw.slice(0, 4096), exitCode } satisfies GatewayResponse,
            { status: 200 }
          );
        }
      } catch (err) {
        log("POST error", { action, error: err instanceof Error ? err.message : String(err) });
        const response: GatewayResponse = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
        return Response.json(response, { status: 500 });
      }
    }

    log("not found", { method: req.method, path: url.pathname });
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[gateway] CRE simulate gateway listening on http://0.0.0.0:${PORT}`);
console.log(`[gateway] CRE_TARGET=${CRE_TARGET} (workflow config). For Docker, use CRE_TARGET=docker-settings so the workflow can reach the host backend.`);
if (CRE_TARGET === "staging-settings") {
  console.log("[gateway] Warning: staging-settings uses backendUrl from config.staging.json. From inside Docker, localhost will not reach the host; set CRE_TARGET=docker-settings (e.g. -e CRE_TARGET=docker-settings after --env-file).");
}
console.log("[gateway] CLI auth: run 'cre login' on the host, then run this container with -v \"$HOME/.cre:/root/.cre\" (or set CRE_API_KEY if you have one).");
