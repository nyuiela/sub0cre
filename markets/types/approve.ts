/**
 * Payload and response types for ERC20 and conditional token approve workflows.
 */

export type ApproveSignerType = "agent" | "backend";

export interface ApproveErc20Payload {
  /** Which key signs the approve tx: "agent" (use agentId) or "backend" (BACKEND_SIGNER_PRIVATE_KEY). */
  signer: ApproveSignerType;
  /** Required when signer is "agent". Secret id in agent-keys namespace. */
  agentId?: string;
  /** Token address (default: config.contracts.usdc). */
  token?: string;
  /** Spender address (e.g. PredictionVault). */
  spender: string;
  /** Allowance amount (wei string). */
  amount: string;
}

export interface ApproveConditionalTokenPayload {
  /** Which key signs: "agent" or "backend". */
  signer: ApproveSignerType;
  /** Required when signer is "agent". */
  agentId?: string;
  /** Conditional token contract (default: config.contracts.conditionalTokens). */
  conditionalTokens?: string;
  /** Operator to approve (e.g. PredictionVault). */
  operator: string;
  /** Approved (true = approve, false = revoke). */
  approved: boolean;
}

export interface ApproveWorkflowResponse {
  status: string;
  result: string;
  signedTx: string;
  signerAddress: string;
  /** Broadcast this via RPC (e.g. cast send --raw <signedTx>) if needed. */
  note?: string;
}
