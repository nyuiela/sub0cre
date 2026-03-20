/**
 * registry-sync: lightweight CRE cron workflow that keeps the Postgres cache in sync
 * with on-chain market state by polling the backend registry-sync endpoint.
 *
 * Purpose: ensures the frontend always has accurate on-chain market data even if a prior
 * callback was missed (e.g. market-discovery workflow network hiccup).
 *
 * Trigger: Cron every 3 min.
 * HTTP trigger also supported for manual runs (action: "sync" | "status").
 *
 * Steps:
 *   1. POST /api/internal/registry-sync with { source: "registry-sync-cron" }.
 *   2. Backend re-reads on-chain MarketCreated events and updates Postgres cache.
 */

import { CronCapability, HTTPCapability, handler, Runner, type Runtime } from "@chainlink/cre-sdk";
import { registrySyncConfigSchema } from "./lib/configSchema";
import { verifyApiKey } from "./lib/httpMiddleware";
import { sendBackendRequest } from "./lib/confidentialHttp";
import type { RegistrySyncConfig } from "./types/config";

const REGISTRY_SYNC_PATH = "/api/internal/registry-sync";

function triggerRegistrySync(
  runtime: Runtime<RegistrySyncConfig>,
  source: string
): { status: string; synced?: number } {
  const config = runtime.config;
  const base = config.backendUrl.replace(/\/$/, "");
  const url = `${base}${REGISTRY_SYNC_PATH}`;
  const body = new TextEncoder().encode(JSON.stringify({ source, markets: [] }));

  runtime.log(`[registry-sync] Triggering sync (source=${source})...`);
  const res = sendBackendRequest(runtime, { url, method: "POST", body });

  if (res.statusCode >= 200 && res.statusCode < 300) {
    const parsed = (() => {
      try {
        return JSON.parse(new TextDecoder().decode(res.body)) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })();
    const synced = typeof parsed.synced === "number" ? parsed.synced : undefined;
    runtime.log(`[registry-sync] Sync complete${synced != null ? ` (synced=${synced})` : ""}.`);
    return { status: "ok", synced };
  }

  const text = new TextDecoder().decode(res.body);
  runtime.log(`[registry-sync] Sync returned ${res.statusCode}: ${text.slice(0, 200)}`);
  return { status: "error" };
}

const onCronTrigger = async (runtime: Runtime<RegistrySyncConfig>): Promise<string> => {
  runtime.log("[registry-sync] Cron triggered.");
  const result = triggerRegistrySync(runtime, "registry-sync-cron");
  return JSON.stringify(result);
};

const onHTTPTrigger = async (
  runtime: Runtime<RegistrySyncConfig>,
  payload: { input: Uint8Array }
): Promise<Record<string, string>> => {
  const body = (() => {
    try {
      return JSON.parse(new TextDecoder().decode(payload.input)) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  verifyApiKey(runtime, body);

  const action = body.action as string | undefined;

  if (action === "sync") {
    const result = triggerRegistrySync(runtime, "registry-sync-http");
    return { status: result.status, synced: String(result.synced ?? 0) };
  }

  if (action === "status") {
    return { status: "ok", workflow: "registry-sync", schedule: runtime.config.schedule };
  }

  throw new Error("HTTP action must be one of: sync, status");
};

const initWorkflow = (
  config: RegistrySyncConfig,
  _secretsProvider: { getSecret: (args: { id: string }) => { result: () => { value?: string } } }
) => {
  const cron = new CronCapability();
  const http = new HTTPCapability();
  return [
    handler(cron.trigger({ schedule: config.schedule }), onCronTrigger),
    handler(http.trigger({}), onHTTPTrigger),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<RegistrySyncConfig>({
    configSchema: registrySyncConfigSchema as never,
  });
  await runner.run(initWorkflow);
}
