/**
 * Create agent key handler: generate random wallet in enclave, optionally encrypt with
 * TEE_MASTER_ENCRYPTION_KEY and return blob. Format matches backend agent-keys.service
 * (aes-256-gcm, scrypt-derived key, iv+authTag+ciphertext base64url) so backend can decrypt
 * when AGENT_ENCRYPTION_SECRET equals TEE_MASTER_ENCRYPTION_KEY.
 * Uses scrypt-js and @noble/ciphers (pure JS) so CRE workflow compiles to browser/WASM target.
 */

import { gcm } from "@noble/ciphers/aes";
import { randomBytes } from "@noble/ciphers/webcrypto";
import { syncScrypt } from "scrypt-js";
import type { Runtime } from "@chainlink/cre-sdk";
import type { CreateAgentKeyPayload, CreateAgentKeyResponse } from "../types/confidential";
import { createRandomAddress } from "../lib/createWalletSync";

const IV_LENGTH = 16;
const KEY_LENGTH = 32;
const GCM_TAG_LENGTH = 16;
const SALT_STR = "sub0-agent-key-v1";
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function deriveKey(masterKey: string): Uint8Array {
  const password = new TextEncoder().encode(masterKey.normalize("NFKC"));
  const salt = new TextEncoder().encode(SALT_STR);
  return syncScrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LENGTH);
}

function encryptPrivateKeyHex(privateKeyHex: string, masterKey: string): string {
  const key = deriveKey(masterKey);
  const iv = randomBytes(IV_LENGTH);
  const aes = gcm(key, iv);
  const plaintext = new TextEncoder().encode(privateKeyHex);
  const ciphertextWithTag = aes.encrypt(plaintext);
  const tag = ciphertextWithTag.slice(-GCM_TAG_LENGTH);
  const ciphertext = ciphertextWithTag.slice(0, -GCM_TAG_LENGTH);
  const combined = new Uint8Array(IV_LENGTH + GCM_TAG_LENGTH + ciphertext.length);
  combined.set(iv, 0);
  combined.set(tag, IV_LENGTH);
  combined.set(ciphertext, IV_LENGTH + GCM_TAG_LENGTH);
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

  let encryptedKeyBlob = "";
  if (masterKey && masterKey.length > 0) {
    try {
      encryptedKeyBlob = encryptPrivateKeyHex(privateKey, masterKey);
    } catch (err) {
      runtime.log(
        `TEE encryption failed (key length or crypto error); returning empty blob: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    runtime.log("TEE_MASTER_ENCRYPTION_KEY not set or empty; returning empty blob (backend will use server-generated keys).");
  }

  runtime.log(`Agent key generated for agentId=${body.agentId}, address=${address}`);

  return { address, encryptedKeyBlob };
}