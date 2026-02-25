/**
 * Approve workflows: ERC20 approve and conditional token setApprovalForAll.
 * Sign with agent key (agent-keys namespace) or backend signer (BACKEND_SIGNER_PRIVATE_KEY).
 * Returns signed tx hex; broadcast via RPC (e.g. cast send --raw) when needed.
 */

import type { Runtime } from "@chainlink/cre-sdk";
import { encodeFunctionData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { WorkflowConfig } from "../types/config";
import type {
  ApproveErc20Payload,
  ApproveConditionalTokenPayload,
  ApproveWorkflowResponse,
} from "../types/approve";
import { CTF_ABI } from "../lib/abis";

const BACKEND_SIGNER_ID = "BACKEND_SIGNER_PRIVATE_KEY";

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address", internalType: "address" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

const DEFAULT_GAS_LIMIT = 300000n;
const DEFAULT_NONCE = 0;
/** Default EIP-1559 gas (2 Gwei) for signing when not fetching from RPC. */
const DEFAULT_MAX_FEE_PER_GAS = 2n * 10n ** 9n;
const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = 1n * 10n ** 9n;

function toAddress(value: string): `0x${string}` {
  const s = String(value ?? "").trim();
  if (s.startsWith("0x")) return s as `0x${string}`;
  return `0x${s}` as `0x${string}`;
}

function resolvePrivateKey(
  runtime: Runtime<WorkflowConfig>,
  signer: "agent" | "backend",
  agentId?: string
): { privateKey: Hex; signerAddress: string } {
  if (signer === "backend") {
    const secret = runtime.getSecret({ id: BACKEND_SIGNER_ID }).result();
    const raw = secret?.value?.trim() ?? "";
    if (!raw) {
      throw new Error(
        "Backend signer secret not configured (BACKEND_SIGNER_PRIVATE_KEY)"
      );
    }
    const privateKey = raw.startsWith("0x") ? (raw as Hex) : (`0x${raw}` as Hex);
    const account = privateKeyToAccount(privateKey);
    return { privateKey, signerAddress: account.address };
  }

  if (signer === "agent") {
    if (!agentId?.trim()) {
      throw new Error('signer is "agent" but agentId is missing');
    }
    const secret = runtime.getSecret({ id: agentId.trim() }).result();
    const raw = secret?.value?.trim() ?? "";
    if (!raw) {
      throw new Error(`Agent key secret not found for agentId=${agentId}; ensure cre secrets create or .env for this agent.`);
    }
    const privateKey = raw.startsWith("0x") ? (raw as Hex) : (`0x${raw}` as Hex);
    const account = privateKeyToAccount(privateKey);
    return { privateKey, signerAddress: account.address };
  }

  throw new Error('signer must be "agent" or "backend"');
}

function parseApproveErc20Payload(input: Uint8Array): ApproveErc20Payload {
  const text = new TextDecoder().decode(input);
  const raw = JSON.parse(text) as Record<string, unknown>;
  const signer = raw.signer as string | undefined;
  if (signer !== "agent" && signer !== "backend") {
    throw new Error('body.signer must be "agent" or "backend"');
  }
  return {
    signer: signer as "agent" | "backend",
    agentId: raw.agentId != null ? String(raw.agentId) : undefined,
    token: raw.token != null ? String(raw.token) : undefined,
    spender: String(raw.spender ?? ""),
    amount: String(raw.amount ?? "0"),
  };
}

function parseApproveConditionalTokenPayload(input: Uint8Array): ApproveConditionalTokenPayload {
  const text = new TextDecoder().decode(input);
  const raw = JSON.parse(text) as Record<string, unknown>;
  const signer = raw.signer as string | undefined;
  if (signer !== "agent" && signer !== "backend") {
    throw new Error('body.signer must be "agent" or "backend"');
  }
  return {
    signer: signer as "agent" | "backend",
    agentId: raw.agentId != null ? String(raw.agentId) : undefined,
    conditionalTokens: raw.conditionalTokens != null ? String(raw.conditionalTokens) : undefined,
    operator: String(raw.operator ?? ""),
    approved: raw.approved !== false,
  };
}

/**
 * Build and sign ERC20 approve(spender, amount). Returns signed tx hex for broadcast.
 */
export async function handleApproveErc20(
  runtime: Runtime<WorkflowConfig>,
  payload: { input: Uint8Array }
): Promise<ApproveWorkflowResponse> {
  runtime.log("CRE Workflow: HTTP Trigger - Approve ERC20");

  const config = runtime.config;
  const contracts = config?.contracts;
  if (!contracts) {
    throw new Error("Missing config.contracts for approve workflows");
  }

  const body = parseApproveErc20Payload(payload.input);
  if (!body.spender?.trim()) {
    throw new Error("spender is required");
  }

  const tokenAddress = body.token?.trim()
    ? toAddress(body.token)
    : (contracts.contracts.usdc as `0x${string}`);
  const spender = toAddress(body.spender);
  const amount = BigInt(body.amount ?? "0");

  const { privateKey, signerAddress } = resolvePrivateKey(
    runtime,
    body.signer,
    body.agentId
  );

  const data = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [spender, amount],
  });

  const account = privateKeyToAccount(privateKey);
  const signedTx = await account.signTransaction({
    type: "eip1559",
    to: tokenAddress,
    data,
    value: 0n,
    gas: DEFAULT_GAS_LIMIT,
    nonce: DEFAULT_NONCE,
    chainId: contracts.chainId,
    maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
  });

  runtime.log(`ERC20 approve signed; signer=${signerAddress}, token=${tokenAddress}, spender=${spender}`);
  return {
    status: "ok",
    result: "approveErc20",
    signedTx,
    signerAddress,
    note: "Broadcast signedTx via RPC (e.g. cast send --raw <signedTx>) if needed.",
  };
}

/**
 * Build and sign conditional token setApprovalForAll(operator, approved). Returns signed tx hex.
 */
export async function handleApproveConditionalToken(
  runtime: Runtime<WorkflowConfig>,
  payload: { input: Uint8Array }
): Promise<ApproveWorkflowResponse> {
  runtime.log("CRE Workflow: HTTP Trigger - Approve Conditional Token");

  const config = runtime.config;
  const contracts = config?.contracts;
  if (!contracts) {
    throw new Error("Missing config.contracts for approve workflows");
  }

  const body = parseApproveConditionalTokenPayload(payload.input);
  if (!body.operator?.trim()) {
    throw new Error("operator is required");
  }

  const ctAddress = body.conditionalTokens?.trim()
    ? toAddress(body.conditionalTokens)
    : (contracts.contracts.conditionalTokens as `0x${string}`);
  const operator = toAddress(body.operator);

  const { privateKey, signerAddress } = resolvePrivateKey(
    runtime,
    body.signer,
    body.agentId
  );

  const data = encodeFunctionData({
    abi: CTF_ABI,
    functionName: "setApprovalForAll",
    args: [operator, body.approved],
  });

  const account = privateKeyToAccount(privateKey);
  const signedTx = await account.signTransaction({
    type: "eip1559",
    to: ctAddress,
    data,
    value: 0n,
    gas: DEFAULT_GAS_LIMIT,
    nonce: DEFAULT_NONCE,
    chainId: contracts.chainId,
    maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
  });

  runtime.log(
    `Conditional token setApprovalForAll signed; signer=${signerAddress}, operator=${operator}, approved=${body.approved}`
  );
  return {
    status: "ok",
    result: "approveConditionalToken",
    signedTx,
    signerAddress,
    note: "Broadcast signedTx via RPC (e.g. cast send --raw <signedTx>) if needed.",
  };
}
