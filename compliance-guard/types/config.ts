/**
 * Workflow config for compliance-guard.
 * HTTP-triggered ACE compliance check: wallet verification, geo guard, policy enforcement.
 */

export interface ComplianceGuardConfig {
  /** Cron schedule (kept for consistency; not primary trigger). */
  schedule: string;
  /** Backend base URL. */
  backendUrl: string;
  /** Secret id for backend API key. */
  backendApiKeySecretId?: string;
  /** When true, use plain HTTP + getSecret (docker/simulate). */
  backendUsePlainAuth?: boolean;
  /** List of blocked country codes (ISO 3166-1 alpha-2). */
  blockedCountries?: string[];
  /** Minimum wallet age in days required to trade. */
  minWalletAgeDays?: number;
}
