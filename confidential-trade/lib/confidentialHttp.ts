/**
 * Confidential HTTP helper for confidential-trade workflow.
 */

import { cre, type Runtime } from "@chainlink/cre-sdk";
import type { ConfidentialTradeConfig } from "../types/config";

const VAULT_SECRET_NAMESPACE = "sub0";
const DEFAULT_VAULT_API_KEY_NAME = "BACKEND_API_KEY";

export interface BackendRequestOptions {
  url: string;
  method: "GET" | "POST";
  body?: Uint8Array;
  contentType?: string;
  noAuth?: boolean;
}

function uint8ArrayToBase64(u8: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
  return btoa(binary);
}

function sendNoAuth(
  runtime: Runtime<ConfidentialTradeConfig>,
  options: BackendRequestOptions
): { statusCode: number; body: Uint8Array } {
  const multiHeaders: Record<string, { values: string[] }> = {};
  if (options.method === "POST") {
    multiHeaders["Content-Type"] = { values: [options.contentType ?? "application/json"] };
  }
  const client = new cre.capabilities.HTTPClient();
  const response = client
    .sendRequest(runtime as never, {
      url: options.url,
      method: options.method,
      body: options.body ?? new Uint8Array(0),
      multiHeaders,
    } as never)
    .result();
  return { statusCode: response.statusCode, body: response.body ?? new Uint8Array(0) };
}

function sendWithKey(
  runtime: Runtime<ConfidentialTradeConfig>,
  options: BackendRequestOptions,
  apiKey: string
): { statusCode: number; body: Uint8Array } {
  const multiHeaders: Record<string, { values: string[] }> = {
    "x-api-key": { values: [apiKey] },
  };
  if (options.method === "POST") {
    multiHeaders["Content-Type"] = { values: [options.contentType ?? "application/json"] };
  }
  const client = new cre.capabilities.HTTPClient();
  const response = client
    .sendRequest(runtime as never, {
      url: options.url,
      method: options.method,
      body: options.body ?? new Uint8Array(0),
      multiHeaders,
    } as never)
    .result();
  return { statusCode: response.statusCode, body: response.body ?? new Uint8Array(0) };
}

export function sendBackendRequest(
  runtime: Runtime<ConfidentialTradeConfig>,
  options: BackendRequestOptions
): { statusCode: number; body: Uint8Array } {
  if (options.noAuth) return sendNoAuth(runtime, options);

  const config = runtime.config;
  if (config.backendUsePlainAuth) {
    const vaultKey = config.backendApiKeySecretId ?? DEFAULT_VAULT_API_KEY_NAME;
    const secret = runtime.getSecret({ id: vaultKey }).result();
    const apiKey = secret?.value?.trim() ?? "";
    if (!apiKey) throw new Error("backendUsePlainAuth=true but BACKEND_API_KEY secret is empty");
    return sendWithKey(runtime, options, apiKey);
  }

  const vaultKey = config.backendApiKeySecretId ?? DEFAULT_VAULT_API_KEY_NAME;
  const multiHeaders: Record<string, { values: string[] }> = {
    "x-api-key": { values: [`{{.${vaultKey}}}`] },
  };
  if (options.method === "POST") {
    multiHeaders["Content-Type"] = { values: [options.contentType ?? "application/json"] };
  }
  const input = {
    vaultDonSecrets: [{ key: vaultKey, namespace: VAULT_SECRET_NAMESPACE }],
    request: {
      url: options.url,
      method: options.method,
      ...(options.body != null && options.body.length > 0
        ? { bodyBytes: uint8ArrayToBase64(options.body) }
        : {}),
      multiHeaders,
      templatePublicValues: {} as Record<string, string>,
      customRootCaCertPem: "",
      encryptOutput: false,
    },
  };
  const client = new cre.capabilities.ConfidentialHTTPClient();
  const response = client.sendRequest(runtime, input as never).result();
  return { statusCode: response.statusCode, body: response.body ?? new Uint8Array(0) };
}
