/**
 * Workflow config for registry-sync.
 * Cron-driven: periodically POST /api/internal/registry-sync to keep Postgres cache in sync.
 */

export interface RegistrySyncConfig {
  /** Cron schedule (e.g. "0 */3 * * * *"). */
  schedule: string;
  /** Backend base URL. */
  backendUrl: string;
  /** Secret id for backend API key. */
  backendApiKeySecretId?: string;
  /** When true, use plain HTTP + getSecret (docker/simulate). */
  backendUsePlainAuth?: boolean;
  /** Contracts config (needs chainSelectorName for on-chain event reads). */
  contracts?: {
    chainId: number;
    chainSelectorName: string;
    contracts: Record<string, string>;
  };
}
