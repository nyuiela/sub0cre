/**
 * Synchronous Ethereum wallet creation for WASM compatibility.
 * CRE/Javy hits "unreachable" when ethers Wallet is in the bundle.
 * Uses @noble/curves secp256k1 + viem keccak256/getAddress; no ethers.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256, getAddress, bytesToHex } from "viem";

/**
 * Generate a random 32-byte private key using crypto.getRandomValues.
 */
function randomPrivateKeyBytes(): Uint8Array {
  const out = new Uint8Array(32);
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < 32; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

/**
 * Create a new Ethereum keypair synchronously. Returns address and private key hex.
 * Use only in enclave; do not log or expose privateKey.
 */
export function createWalletSync(): { address: string; privateKey: string } {
  const privKeyBytes = randomPrivateKeyBytes();
  const pubKey = secp256k1.getPublicKey(privKeyBytes, false);
  const pubKeyNoPrefix = pubKey.slice(1);
  const hash = keccak256(pubKeyNoPrefix);
  const addressHex = `0x${hash.slice(-40)}`;
  const address = getAddress(addressHex);
  const privateKey = bytesToHex(privKeyBytes);
  return { address, privateKey };
}

/**
 * Create a new wallet and return only the address (for createAgentKey workflow).
 */
export function createRandomAddress(): { address: string; privateKey: string } {
  return createWalletSync();
}
