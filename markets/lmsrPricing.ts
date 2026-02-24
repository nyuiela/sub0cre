/**
 * CRE HTTP workflow: LMSR pricing (Dual-Signature Relayer).
 * Standalone entrypoint; same logic also available as action "lmsrPricing" in main workflow.
 */

import { HTTPCapability, handler, Runner } from "@chainlink/cre-sdk";
import type { LmsrPricingConfig } from "./types/lmsr";
import { handleLmsrPricing } from "./workflows/lmsrPricing";

function onHTTPTrigger(
  runtime: Parameters<typeof handleLmsrPricing>[0],
  payload: { input: Uint8Array }
) {
  return handleLmsrPricing(runtime, payload);
}

export async function main() {
  const runner = await Runner.newRunner<LmsrPricingConfig>();
  await runner.run(() => {
    const http = new HTTPCapability();
    return [handler(http.trigger({}), onHTTPTrigger)];
  });
}
