/**
 * Create agent key handler: generate random wallet, return address only.
 * Used by main (action createAgentKey) and by standalone createAgentKey workflow.
 */

import type { Runtime, } from "@chainlink/cre-sdk";
import type { CreateAgentKeyPayload, CreateAgentKeyResponse } from "../types/confidential";
import { createRandomAddress } from "../lib/createWalletSync";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

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

  const masterKeySecret = runtime.getSecret({ id: "TEE_MASTER_ENCRYPTION_KEY" }).result();
  const masterKey = masterKeySecret?.value?.trim();

  const { address, privateKey } = createRandomAddress();
  // Encrypted blob is intentionally empty: the private key stays in the enclave and is not
  // returned. The backend only stores the address; signing is done via CRE (quote/order).
  // In simulation, getSecret often returns nothing, so encryption would yield empty anyway.
  // To persist the key outside CRE you would encrypt with masterKey and return it here
  // (and have the gateway call the backend callback with encryptedPrivateKey).
  const encryptedKeyBlob = "";

  runtime.log(`Agent key generated for agentId=${body.agentId}, address=${address}`);

  return { address, encryptedKeyBlob };
}

// export function handleCreateAgentKey(runtime: Runtime<unknown>, payload: any): CreateAgentKeyResponse {
//   // 1. Fetch the ONE master key from CRE Secrets
//   const masterKeySecret = runtime.getSecret({ id: "TEE_MASTER_ENCRYPTION_KEY" }).result();
//   const masterKey = masterKeySecret?.value?.trim();

//   // 2. Generate the Agent's raw private key in the enclave
//   const rawPrivateKey = generatePrivateKey();
//   runtime.log(`Agent key generated for agentId=, address`);
//   const account = privateKeyToAccount(rawPrivateKey);

//   // 3. Encrypt the private key using the Master Key
//   const encryptedAgentKey = AES.encrypt(rawPrivateKey, masterKey as string).toString();

//   // 4. Return the public address and the encrypted blob to your backend
//   return {
//     address: account.address,
//     // encryptedKeyBlob: encryptedAgentKey
//     encryptedKeyBlob: ""
//   };
// }