import type { Runtime } from "@chainlink/cre-sdk";

const API_KEY_SECRET_ID = "HTTP_API_KEY";

export function verifyApiKey(runtime: Runtime<unknown>, body: Record<string, unknown>): void {
  try {
    const secret = runtime.getSecret({ id: API_KEY_SECRET_ID }).result();
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
