/**
 * Confidential HTTP: backend requests with API key injected from vault only.
 * No response encryption or base64 encoding; request headers use vault template so the key never appears in workflow code.
 *
 * When config.backendUsePlainAuth is true (e.g. docker-settings), uses getSecret + HTTP capability so
 * simulate/Docker work without DON vault template resolution.
 *
 * The capability decodes input as JSON (HTTPRequestJson); it expects bodyBytes (base64) or bodyString, not "body".
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
  /** When set, use this key for x-api-key (normal HTTP). Caller can pass trigger body.apiKey so no vault/getSecret needed. */
  apiKey?: string;
  /** When true, send request with no auth header (for /api/cre/* no-auth endpoints). No vault/getSecret. */
  noAuth?: boolean;
}

/** Uint8Array to base64 for JSON-encoded bytes (works in WASM). */
function uint8ArrayToBase64(u8: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
  return btoa(binary);
}

/**
 * Plain HTTP with no auth header. For /api/cre/* endpoints.
 */
function sendBackendRequestNoAuth(
  runtime: Runtime<WorkflowConfig>,
  options: ConfidentialBackendRequestOptions
): { statusCode: number; body: Uint8Array } {
  const multiHeaders: Record<string, { values: string[] }> = {};
  if (options.method === "POST") {
    multiHeaders["Content-Type"] = { values: [options.contentType ?? "application/json"] };
  }
  const request = {
    url: options.url,
    method: options.method,
    body: options.body ?? new Uint8Array(0),
    multiHeaders,
  };
  const client = new cre.capabilities.HTTPClient();
  const response = client.sendRequest(runtime as never, request as never).result();
  return {
    statusCode: response.statusCode,
    body: response.body ?? new Uint8Array(0),
  };
}

/**
 * Plain HTTP path: send request with x-api-key from the given key (no vault/getSecret).
 * Used when options.apiKey is provided (e.g. from trigger body.apiKey) or when backendUsePlainAuth + getSecret.
 */
function sendBackendRequestWithKey(
  runtime: Runtime<WorkflowConfig>,
  options: ConfidentialBackendRequestOptions,
  apiKey: string
): { statusCode: number; body: Uint8Array } {
  const multiHeaders: Record<string, { values: string[] }> = {
    "x-api-key": { values: [apiKey] },
  };
  if (options.method === "POST") {
    multiHeaders["Content-Type"] = { values: [options.contentType ?? "application/json"] };
  }
  const request = {
    url: options.url,
    method: options.method,
    body: options.body ?? new Uint8Array(0),
    multiHeaders,
  };
  const client = new cre.capabilities.HTTPClient();
  const response = client.sendRequest(runtime as never, request as never).result();
  return {
    statusCode: response.statusCode,
    body: response.body ?? new Uint8Array(0),
  };
}

/**
 * Plain HTTP path: get API key from getSecret and send via HTTP capability.
 * Use only when backendUsePlainAuth is true (simulate/Docker) and options.apiKey not provided.
 */
function sendPlainBackendRequest(
  runtime: Runtime<WorkflowConfig>,
  options: ConfidentialBackendRequestOptions
): { statusCode: number; body: Uint8Array } {
  const config = runtime.config;
  const vaultKey = config.backendApiKeySecretId ?? DEFAULT_VAULT_API_KEY_NAME;
  const secret = runtime.getSecret({ id: vaultKey }).result();
  const apiKey = secret?.value?.trim() ?? "";
  if (!apiKey) {
    throw new Error(
      "backendUsePlainAuth is true but BACKEND_API_KEY secret is empty; set it in .env to match backend API_KEY"
    );
  }
  return sendBackendRequestWithKey(runtime, options, apiKey);
}

/**
 * Builds input for Confidential HTTP in the JSON shape the capability expects (ConfidentialHTTPRequestJson).
 * Uses bodyBytes (base64) not "body" so fromJson does not reject the message.
 */
function buildConfidentialBackendRequest(
  config: WorkflowConfig,
  options: ConfidentialBackendRequestOptions
): {
  vaultDonSecrets: Array<{ key: string; namespace: string }>;
  request: {
    url: string;
    method: string;
    bodyBytes?: string;
    multiHeaders: Record<string, { values: string[] }>;
    templatePublicValues: Record<string, string>;
    customRootCaCertPem: string;
    encryptOutput: boolean;
  };
} {
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
    ...(options.body != null && options.body.length > 0
      ? { bodyBytes: uint8ArrayToBase64(options.body) }
      : {}),
    multiHeaders,
    templatePublicValues: {} as Record<string, string>,
    customRootCaCertPem: "",
    encryptOutput: false,
  };
  return {
    vaultDonSecrets: [{ key: vaultKey, namespace: VAULT_SECRET_NAMESPACE }],
    request,
  };
}

/**
 * Sends a request to the backend. When options.noAuth is true, uses plain HTTP with no auth (for /api/cre/*).
 * When options.apiKey is set, uses that key for x-api-key. Otherwise getSecret or Confidential HTTP.
 */
export function sendConfidentialBackendRequest(
  runtime: Runtime<WorkflowConfig>,
  options: ConfidentialBackendRequestOptions
): { statusCode: number; body: Uint8Array } {
  if (options.noAuth) {
    return sendBackendRequestNoAuth(runtime, options);
  }
  const explicitKey = options.apiKey?.trim();
  if (explicitKey) {
    return sendBackendRequestWithKey(runtime, options, explicitKey);
  }
  const config = runtime.config;
  if (config.backendUsePlainAuth) {
    return sendPlainBackendRequest(runtime, options);
  }
  const input = buildConfidentialBackendRequest(config, options);
  const client = new cre.capabilities.ConfidentialHTTPClient();
  const response = client.sendRequest(runtime, input as never).result();
  return {
    statusCode: response.statusCode,
    body: response.body ?? new Uint8Array(0),
  };
}
