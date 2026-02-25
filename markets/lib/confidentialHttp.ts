/**
 * Confidential HTTP: backend requests with API key injected from vault only.
 * No response encryption or base64 encoding; request headers use vault template so the key never appears in workflow code.
 */

import { cre, type Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";

const VAULT_SECRET_NAMESPACE = "sub0";
const DEFAULT_VAULT_API_KEY_NAME = "BACKEND_API_KEY";

export interface ConfidentialBackendRequestOptions {
  url: string;
  method: "GET" | "POST";
  body?: Uint8Array;
  contentType?: string;
}

/** Plain shape we pass to ConfidentialHTTPClient; cast to satisfy protobuf Message type at call site. */
interface ConfidentialInput {
  vaultDonSecrets: Array<{ key: string; namespace: string }>;
  request: {
    url: string;
    method: string;
    body?: { value: Uint8Array; case: "bodyBytes" };
    multiHeaders: Record<string, { values: string[] }>;
    templatePublicValues: Record<string, string>;
    customRootCaCertPem: Uint8Array;
    encryptOutput: boolean;
  };
}

/**
 * Builds input for Confidential HTTP so the backend API key is injected from vault (template {{.key}}).
 * Uses config.backendApiKeySecretId as vault key when set; otherwise BACKEND_API_KEY.
 */
function buildConfidentialBackendRequest(
  config: WorkflowConfig,
  options: ConfidentialBackendRequestOptions
): ConfidentialInput {
  const vaultKey = config.backendApiKeySecretId ?? DEFAULT_VAULT_API_KEY_NAME;
  const multiHeaders: Record<string, { values: string[] }> = {
    "x-api-key": { values: ["{{." + vaultKey + "}}"] },
  };
  if (options.method === "POST") {
    multiHeaders["Content-Type"] = { values: [options.contentType ?? "application/json"] };
  }
  const request = {
    url: options.url,
    method: options.method,
    body: options.body != null && options.body.length > 0
      ? { value: options.body, case: "bodyBytes" as const }
      : undefined,
    multiHeaders,
    templatePublicValues: {} as Record<string, string>,
    customRootCaCertPem: new Uint8Array(0),
    encryptOutput: false,
  };
  return {
    vaultDonSecrets: [{ key: vaultKey, namespace: VAULT_SECRET_NAMESPACE }],
    request,
  };
}

/**
 * Sends a confidential HTTP request to the backend. API key is supplied by the DON from vault;
 * it is never read or logged in the workflow.
 */
export function sendConfidentialBackendRequest(
  runtime: Runtime<WorkflowConfig>,
  options: ConfidentialBackendRequestOptions
): { statusCode: number; body: Uint8Array } {
  const config = runtime.config;
  const input = buildConfidentialBackendRequest(config, options);
  const client = new cre.capabilities.ConfidentialHTTPClient();
  const response = client.sendRequest(runtime, input as never).result();
  return {
    statusCode: response.statusCode,
    body: response.body ?? new Uint8Array(0),
  };
}
