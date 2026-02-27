/**
 * Synchronous Ethereum wallet creation for WASM compatibility.
 * CRE/Javy hits "unreachable" when ethers Wallet is in the bundle.
 * Uses @noble/curves secp256k1 + viem keccak256/getAddress; no ethers.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256, getAddress, bytesToHex } from "viem";

/**
 * Generate a random 32-byte private key using crypto.getRandomValues.
 * When entropy is provided, XOR it with a hash of entropy so each call yields a different key
 * even when the runtime's RNG is deterministic (e.g. CRE simulation).
 */
function randomPrivateKeyBytes(entropy?: string): Uint8Array {
  const out = new Uint8Array(32);
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < 32; i++) out[i] = Math.floor(Math.random() * 256);
  }
  if (entropy != null && entropy.length > 0) {
    const entropyBytes = new TextEncoder().encode(entropy);
    const mix = keccak256(entropyBytes.length ? entropyBytes : new Uint8Array([0]));
    const mixHex = mix.startsWith("0x") ? mix.slice(2) : mix;
    for (let i = 0; i < 32; i++) {
      out[i] ^= parseInt(mixHex.slice(i * 2, i * 2 + 2), 16) ?? 0;
    }
    if (out[0] === 0) out[0] = 1;
  }
  return out;
}

/**
 * Create a new Ethereum keypair synchronously. Returns address and private key hex.
 * Use only in enclave; do not log or expose privateKey.
 */
export function createWalletSync(entropy?: string): { address: string; privateKey: string } {
  const privKeyBytes = randomPrivateKeyBytes(entropy);
  const pubKey = secp256k1.getPublicKey(privKeyBytes, false);
  const pubKeyNoPrefix = pubKey.slice(1);
  const hash = keccak256(pubKeyNoPrefix);
  const addressHex = `0x${hash.slice(-40)}`;
  const address = getAddress(addressHex);
  const privateKey = bytesToHex(privKeyBytes);
  return { address, privateKey };
}

/**
 * Create a new wallet (for createAgentKey). Pass optional entropy so each run gets a different address when RNG is deterministic.
 */
export function createRandomAddress(entropy?: string): { address: string; privateKey: string } {
  return createWalletSync(entropy);
}
