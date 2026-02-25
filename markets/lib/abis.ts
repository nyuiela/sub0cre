/**
 * Contract ABIs for CRE reads and writes.
 * Loaded from lib/abi/*.json to match deployed contracts exactly and aid debugging.
 */

import type { Abi } from "viem";
import sub0AbiJson from "./abi/sub0.json";
import predictionVaultAbiJson from "./abi/predictionVault.json";
import conditionalTokenAbiJson from "./abi/conditionalToken.json";
import forwarderAbiJson from "./abi/forwarder.json";

export const SUB0_ABI = sub0AbiJson as Abi;
export const PREDICTION_VAULT_ABI = predictionVaultAbiJson as Abi;
export const CTF_ABI = conditionalTokenAbiJson as Abi;
/** Chainlink Keystone Forwarder: report(), route(), getTransmissionId, getTransmissionInfo, getTransmitter, ReportProcessed event. */
export const FORWARDER_ABI = forwarderAbiJson as Abi;
