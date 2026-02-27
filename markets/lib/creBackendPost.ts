/**
 * POST workflow results to backend CRE endpoints (e.g. /api/cre/quote, /api/cre/stake).
 * Mirrors createAgentKey: Confidential HTTP with vault template for API key.
 */

import type { ConfidentialHTTPClient, Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";

const VAULT_API_KEY = "BACKEND_API_VAR";

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * POST a workflow result to the backend at config.backendUrl + path.
 * Serializes BigInt to string. Logs and swallows errors so the workflow still returns the result.
 */
export function postCreResultToBackend(
  runtime: Runtime<unknown>,
  client: ConfidentialHTTPClient,
  config: WorkflowConfig | undefined,
  path: string,
  result: unknown
): void {
  const base = config?.backendUrl ?? (runtime.config as { backendUrl?: string })?.backendUrl;
  if (!base?.trim()) {
    runtime.log("postCreResultToBackend: backendUrl not set; skipping POST.");
    return;
  }
  const url = `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  const bodyString = JSON.stringify(
    typeof result === "object" && result !== null ? result : { result },
    bigintReplacer
  );
  try {
    client.sendRequest(runtime, {
      request: {
        url,
        method: "POST",
        multiHeaders: {
          Authorization: { values: ["Basic {{.apiKey}}"] },
        },
        bodyString,
      },
      vaultDonSecrets: [{ key: VAULT_API_KEY }],
    }).result();
    runtime.log(`Posted result to ${path}`);
  } catch (err) {
    runtime.log(
      `postCreResultToBackend failed for ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
