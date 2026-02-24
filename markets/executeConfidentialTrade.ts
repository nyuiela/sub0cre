/**
 * CRE Confidential HTTP workflow: sign and submit executeTrade in the enclave.
 * Standalone entrypoint; same logic also available as action "executeConfidentialTrade" in main workflow.
 */

import { HTTPCapability, handler, Runner } from "@chainlink/cre-sdk";
import type { ExecuteConfidentialTradeConfig } from "./types/confidential";
import { handleExecuteConfidentialTrade } from "./workflows/executeConfidentialTrade";

export type { ExecuteConfidentialTradeConfig };

function onHTTPTrigger(
  runtime: Parameters<typeof handleExecuteConfidentialTrade>[0],
  payload: { input: Uint8Array }
) {
  return handleExecuteConfidentialTrade(runtime, payload);
}

export async function main() {
  const runner = await Runner.newRunner<ExecuteConfidentialTradeConfig>();
  await runner.run(() => {
    const http = new HTTPCapability();
    return [handler(http.trigger({}), onHTTPTrigger)];
  });
}
