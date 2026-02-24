/**
 * Contract ABIs for CRE reads and writes.
 * Loaded from lib/abi/*.json to match deployed contracts exactly and aid debugging.
 */

import type { Abi } from "viem";
import sub0AbiJson from "./abi/sub0.json";
import predictionVaultAbiJson from "./abi/predictionVault.json";
import conditionalTokenAbiJson from "./abi/conditionalToken.json";

export const SUB0_ABI = sub0AbiJson as Abi;
export const PREDICTION_VAULT_ABI = predictionVaultAbiJson as Abi;
export const CTF_ABI = conditionalTokenAbiJson as Abi;
