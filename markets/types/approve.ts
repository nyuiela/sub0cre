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
  /** Transaction nonce for signer (required for broadcast; fetch with: cast nonce <signerAddress> --rpc-url <RPC_URL>). */
  nonce?: string;
  /** Whether to invoke the approve tx from the user (true) or from the backend (false). */
  userInvoke: boolean;
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
  /** Transaction nonce for signer (fetch with: cast nonce <signerAddress> --rpc-url <RPC_URL>). */
  nonce?: string;
  /** When false, workflow broadcasts the tx; when true, returns signed tx for client. */
  userInvoke?: boolean;
}

export interface ApproveWorkflowResponse {
  status: string;
  result: string;
  signedTx: string;
  signerAddress: string;
  /** True when userInvoke=false; client must call eth_sendRawTransaction(signedTx). */
  broadcastRequired?: boolean;
  /** Set when workflow broadcast the tx (not used in CRE WASM; client broadcasts). */
  txHash?: string;
  note?: string;
}
