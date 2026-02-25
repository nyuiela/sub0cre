/**
 * Contract configuration types for Sub0 CRE integration.
 * Matches contracts.json structure keyed by CRE target.
 */

export interface ChainContracts {
  sub0: string;
  predictionVault: string;
  conditionalTokens: string;
  vault: string;
  usdc: string;
  hub: string;
  /** Agent settlement receiver (CRE writes resolution report here). Optional. */
  agentSettlementReceiver?: string;
}

export interface EIP712Config {
  domainName: string;
  domainVersion: string;
  quoteTypeName: string;
}

export interface Conventions {
  usdcDecimals: number;
  outcomeTokenDecimals: number;
  parentCollectionId: string;
}

export interface ChainContractConfig {
  chainId: number;
  chainSelectorName: string;
  /** Gas limit for writeReport (e.g. create market). Default 500000 if omitted. */
  gasLimit?: string;
  contracts: ChainContracts;
  eip712: EIP712Config;
  conventions: Conventions;
}

export type ContractsConfigByTarget = Record<string, ChainContractConfig>;
