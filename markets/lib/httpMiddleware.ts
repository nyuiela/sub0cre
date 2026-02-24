/**
 * HTTP trigger middleware: verify API key when configured.
 * If secret HTTP_API_KEY (namespace sub0) is set, requires body.apiKey to match.
 */

import type { Runtime } from "@chainlink/cre-sdk";

const API_KEY_SECRET_NAMESPACE = "sub0";
const API_KEY_SECRET_ID = "HTTP_API_KEY";

/**
 * Verifies API key when CRE secret HTTP_API_KEY is configured.
 * Expects body.apiKey (string). If secret exists and is non-empty, throws if body.apiKey !== secret.value.
 * If secret is not set or empty, no check is performed.
 */
export function verifyApiKey(
  runtime: Runtime<unknown>,
  body: Record<string, unknown>
): void {
  try {
    const secret = runtime.getSecret({ id: API_KEY_SECRET_ID, namespace: API_KEY_SECRET_NAMESPACE }).result();
    const expected = secret?.value?.trim() ?? "";
    if (expected.length === 0) return;

    const provided = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (provided !== expected) {
      runtime.log("HTTP trigger: API key missing or invalid.");
      throw new Error("Unauthorized: invalid or missing apiKey");
    }
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized: invalid or missing apiKey") throw err;
    return;
  }
}
