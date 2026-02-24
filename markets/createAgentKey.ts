/**
 * CRE HTTP workflow: Secure Agent Key Generation (Privacy Track).
 * Standalone entrypoint; same logic also available as action "createAgentKey" in main workflow.
 */

import { HTTPCapability, handler, Runner } from "@chainlink/cre-sdk";
import type { CreateAgentKeyConfig } from "./types/confidential";
import { handleCreateAgentKey } from "./workflows/createAgentKey";

export type { CreateAgentKeyConfig };

function onHTTPTrigger(
  runtime: Parameters<typeof handleCreateAgentKey>[0],
  payload: { input: Uint8Array }
) {
  return handleCreateAgentKey(runtime, payload);
}

export async function main() {
  const runner = await Runner.newRunner<CreateAgentKeyConfig>();
  await runner.run(() => {
    const http = new HTTPCapability();
    return [handler(http.trigger({}), onHTTPTrigger)];
  });
}
