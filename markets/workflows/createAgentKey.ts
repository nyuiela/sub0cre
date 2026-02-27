/**
 * Create agent key handler: generate random wallet in enclave, optionally encrypt with
 * TEE_MASTER_ENCRYPTION_KEY and return blob. Uses Web Crypto (PBKDF2 + AES-GCM) so it
 * works in CRE/Javy. Sends ~$10 ETH to agent and returns signed ERC20/CT approves.
 */

import type { ConfidentialHTTPClient, Runtime } from "@chainlink/cre-sdk";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { CreateAgentKeyPayload, CreateAgentKeyResponse } from "../types/confidential";
import type { WorkflowConfig } from "../types/config";
import { createRandomAddress } from "../lib/createWalletSync";
import {
  signApproveErc20WithKey,
  signApproveConditionalTokenWithKey,
} from "./approveWorkflows";

const IV_LENGTH = 12;
const SALT_STR = "sub0-agent-key-v1";
const PBKDF2_ITERATIONS = 600_000;

/** ~$10 ETH at typical prices (0.003 ETH). Backend broadcasts signedEthTransfer to fund agent. */
const ETH_AGENT_FUNDING_WEI = 3n * 10n ** 15n;
const DEFAULT_GAS_LIMIT = 300000n;
const DEFAULT_NONCE = 0;
const DEFAULT_MAX_FEE_PER_GAS = 2n * 10n ** 9n;
const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = 1n * 10n ** 9n;

function randomIV(length: number): Uint8Array {
  const out = new Uint8Array(length);
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

/**
 * Encrypt private key with Web Crypto: PBKDF2-SHA256 key derivation + AES-GCM.
 * Blob format: iv (12 bytes) || ciphertext (includes 16-byte auth tag).
 * Backend decrypts with same salt, iterations, and AES-GCM.
 */
async function encryptPrivateKeyHex(privateKeyHex: string, masterKey: string): Promise<string> {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) {
    throw new Error("Web Crypto subtle is not available (required for encryption)");
  }
  const password = new TextEncoder().encode(masterKey.normalize("NFKC"));
  const salt = new TextEncoder().encode(SALT_STR);
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    password,
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const keyBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    256
  );
  const key = await crypto.subtle.importKey(
    "raw",
    keyBits,
    "AES-GCM",
    false,
    ["encrypt"]
  );
  const iv = randomIV(IV_LENGTH);
  const ivCopy = new Uint8Array(IV_LENGTH);
  ivCopy.set(iv);
  const plaintext = new TextEncoder().encode(privateKeyHex);
  const ciphertextWithTag = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: ivCopy,
      tagLength: 128,
    },
    key,
    plaintext
  );
  const combined = new Uint8Array(IV_LENGTH + ciphertextWithTag.byteLength);
  combined.set(ivCopy, 0);
  combined.set(new Uint8Array(ciphertextWithTag), IV_LENGTH);
  return uint8ArrayToBase64Url(combined);
}

function uint8ArrayToBase64Url(u8: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function parseCreateAgentKeyPayload(input: Uint8Array): CreateAgentKeyPayload {
  const text = new TextDecoder().decode(input);
  const raw = JSON.parse(text) as Record<string, unknown>;
  const agentId = typeof raw.agentId === "string" ? raw.agentId.trim() : "";
  if (!agentId) {
    throw new Error("Missing or invalid body.agentId");
  }
  const funderNonce =
    raw.funderNonce != null ? Number(raw.funderNonce) : undefined;
  const entropy = typeof raw.entropy === "string" ? raw.entropy.trim() || undefined : undefined;
  return { agentId, funderNonce, entropy };
}

/**
 * Create agent key handler: generate random wallet in enclave, optionally encrypt with
 * TEE_MASTER_ENCRYPTION_KEY, sign ETH transfer + ERC20/CT approves, POST to backend.
 * Caller must pass funderNonce (eth_getTransactionCount for BACKEND_SIGNER_PRIVATE_KEY address)
 * so the signed ETH transfer can be broadcast without "nonce too low".
 * When entropy is omitted, agentId is used so each agent gets a different address.
 */
export async function handleCreateAgentKey(
  runtime: Runtime<unknown>,
  client: ConfidentialHTTPClient,
  payload: { input: Uint8Array }
): Promise<CreateAgentKeyResponse> {
  const body = parseCreateAgentKeyPayload(payload.input);

  const masterKeySecret = runtime.getSecret({ id: "TEE_MASTER_ENCRYPTION_KEY" }).result();
  const masterKey = masterKeySecret?.value?.trim();

  const { address, privateKey } = createRandomAddress(body.entropy ?? body.agentId);
  let encryptedKeyBlob = privateKey;
  // if (masterKey && masterKey.length > 0) {
  //   try {
  //     encryptedKeyBlob = await encryptPrivateKeyHex(privateKey, masterKey);
  //   } catch (err) {
  //     runtime.log(
  //       `TEE encryption failed (key length or crypto error); returning empty blob: ${err instanceof Error ? err.message : String(err)}`
  //     );
  //   }
  // } else {
  //   runtime.log("TEE_MASTER_ENCRYPTION_KEY not set or empty; returning empty blob (backend will use server-generated keys).");
  // }

  const config = runtime.config as WorkflowConfig;
  const contracts = config?.contracts;
  let signedEthTransfer: string | undefined;
  let signedErc20: string | undefined;
  let signedCT: string | undefined;

  if (contracts) {
    const funderSecret = runtime.getSecret({ id: "BACKEND_SIGNER_PRIVATE_KEY" }).result();
    const funderKeyRaw = funderSecret?.value?.trim() ?? "";
    if (funderKeyRaw) {
      const funderKey = funderKeyRaw.startsWith("0x") ? (funderKeyRaw as Hex) : (`0x${funderKeyRaw}` as Hex);
      const funderAccount = privateKeyToAccount(funderKey);
      const funderNonce = body.funderNonce ?? DEFAULT_NONCE;
      try {
        signedEthTransfer = await funderAccount.signTransaction({
          type: "eip1559",
          to: address as `0x${string}`,
          data: "0x",
          value: ETH_AGENT_FUNDING_WEI,
          gas: DEFAULT_GAS_LIMIT,
          nonce: funderNonce,
          chainId: contracts.chainId,
          maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
          maxPriorityFeePerGas: DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
        });
        runtime.log(`Signed ETH transfer (~$10) to agent ${address} for broadcast by backend.`);
      } catch (err) {
        runtime.log(`Failed to sign ETH transfer: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      runtime.log("BACKEND_SIGNER_PRIVATE_KEY not set; skipping signedEthTransfer.");
    }

    const agentKeyHex = privateKey.startsWith("0x") ? (privateKey as Hex) : (`0x${privateKey}` as Hex);
    const predictionVault = contracts.contracts.predictionVault as string;
    try {
      const erc20Result = await signApproveErc20WithKey(runtime as Runtime<WorkflowConfig>, agentKeyHex, {
        spender: predictionVault,
        nonce: 0,
      });
      signedErc20 = erc20Result.signedTx;
      runtime.log("Signed ERC20 approve for agent; backend will broadcast.");
    } catch (err) {
      runtime.log(`Failed to sign ERC20 approve: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const ctResult = await signApproveConditionalTokenWithKey(runtime as Runtime<WorkflowConfig>, agentKeyHex, {
        operator: predictionVault,
        approved: true,
        nonce: 0,
      });
      signedCT = ctResult.signedTx;
      runtime.log("Signed conditional token setApprovalForAll for agent; backend will broadcast.");
    } catch (err) {
      runtime.log(`Failed to sign CT approve: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    runtime.log("No config.contracts; skipping signedEthTransfer, signedErc20, signedCT.");
  }

  const postBody: Record<string, unknown> = {
    agentId: body.agentId,
    address,
    encryptedKeyBlob,
  };
  if (signedEthTransfer != null) postBody.signedEthTransfer = signedEthTransfer;
  if (signedErc20 != null) postBody.signedErc20 = signedErc20;
  if (signedCT != null) postBody.signedCT = signedCT;

  client.sendRequest(runtime, {
    request: {
      url: `${config?.backendUrl ?? (runtime.config as { backendUrl: string }).backendUrl}/api/cre/agent-keys`,
      method: "POST",
      multiHeaders: {
        Authorization: { values: ["Basic {{.apiKey}}"] },
      },
      // body: { value: new TextEncoder().encode(JSON.stringify(postBody)), case: "bodyBytes" },
      bodyString: JSON.stringify(postBody),
    },
    vaultDonSecrets: [{ key: "BACKEND_API_VAR" }],
  }).result();

  runtime.log(`Agent key generated for agentId=${body.agentId}, address=${address}`);

  const response: CreateAgentKeyResponse = { address, encryptedKeyBlob };
  if (signedEthTransfer != null) response.signedEthTransfer = signedEthTransfer;
  if (signedErc20 != null) response.signedErc20 = signedErc20;
  if (signedCT != null) response.signedCT = signedCT;
  return response;
}