/**
 * Create agent key handler: generate random wallet, return address only.
 * Used by main (action createAgentKey) and by standalone createAgentKey workflow.
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { CreateAgentKeyPayload, CreateAgentKeyResponse } from "../types/confidential";
import { createRandomAddress } from "../lib/createWalletSync";

export function parseCreateAgentKeyPayload(input: Uint8Array): CreateAgentKeyPayload {
  const text = new TextDecoder().decode(input);
  const raw = JSON.parse(text) as Record<string, unknown>;
  const agentId = typeof raw.agentId === "string" ? raw.agentId.trim() : "";
  if (!agentId) {
    throw new Error("Missing or invalid body.agentId");
  }
  return { agentId };
}

export function handleCreateAgentKey(
  runtime: Runtime<unknown>,
  payload: { input: Uint8Array }
): CreateAgentKeyResponse {
  const body = parseCreateAgentKeyPayload(payload.input);

  const address = createRandomAddress();

  runtime.log(`Agent key generated for agentId=${body.agentId}, address=${address}`);

  return { address, txHash: "" };
}
