/**
 * Synchronous EIP-712 signTypedData for WASM compatibility.
 * CRE/Javy hits "unreachable" with async handlers; viem signTypedData is async.
 * Uses viem hashTypedData (sync) + @noble/curves secp256k1 (sync) + viem serializeSignature.
 */

import { hashTypedData, serializeSignature, hexToBytes, numberToHex } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import type { Hex } from "viem";

export interface SignTypedDataParams {
  domain: { name?: string; version?: string; chainId?: number; verifyingContract?: string };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
  privateKey: Hex;
}

/**
 * Sign EIP-712 typed data synchronously. Returns 65-byte signature hex (r + s + v).
 */
export function signTypedDataSync(params: SignTypedDataParams): Hex {
  const { domain, types, primaryType, message, privateKey } = params;
  const hash = hashTypedData({ domain, types, primaryType, message });
  const hashBytes = hexToBytes(hash);
  const keyBytes = hexToBytes(privateKey);
  const sig = secp256k1.sign(hashBytes, keyBytes, { lowS: true });
  const r = numberToHex(sig.r, { size: 32 }) as Hex;
  const s = numberToHex(sig.s, { size: 32 }) as Hex;
  const yParity = sig.recovery === 1 ? 1 : 0;
  return serializeSignature({ r, s, yParity, to: "hex" });
}
