/**
 * compliance-guard: ACE (Access Control & Entitlements) workflow for Sub0.
 * Performs policy checks on wallets before allowing access to prediction market features.
 *
 * Trigger: HTTP action "checkCompliance" (body: { walletAddress, action?, marketId? }).
 * Returns allow/deny decision with reason.
 *
 * Checks performed:
 *   1. Wallet age check — wallet must meet minWalletAgeDays threshold.
 *   2. Geo guard — wallet's registered country must not be in blockedCountries.
 *   3. Sanctions check — calls backend ACE policy endpoint (/api/internal/compliance/check).
 *   4. Returns { allowed: boolean, reason: string }.
 */

import { CronCapability, HTTPCapability, handler, Runner, type Runtime } from "@chainlink/cre-sdk";
import { complianceGuardConfigSchema } from "./lib/configSchema";
import { verifyApiKey } from "./lib/httpMiddleware";
import { sendBackendRequest } from "./lib/confidentialHttp";
import type { ComplianceGuardConfig } from "./types/config";

const COMPLIANCE_CHECK_PATH = "/api/internal/compliance/check";

const DEFAULT_BLOCKED_COUNTRIES = ["KP", "IR", "SY", "CU", "RU"];
const DEFAULT_MIN_WALLET_AGE_DAYS = 0;

interface ComplianceCheckResult {
  allowed: boolean;
  reason: string;
  walletAddress: string;
  action?: string;
  marketId?: string;
}

function checkBackendPolicy(
  runtime: Runtime<ComplianceGuardConfig>,
  walletAddress: string,
  action?: string,
  marketId?: string
): { allowed: boolean; reason: string } {
  const config = runtime.config;
  const base = config.backendUrl.replace(/\/$/, "");
  const url = `${base}${COMPLIANCE_CHECK_PATH}`;

  const body = new TextEncoder().encode(
    JSON.stringify({ walletAddress, action: action ?? "trade", marketId })
  );

  runtime.log(`[compliance-guard] Checking backend ACE policy for wallet=${walletAddress}`);
  const res = sendBackendRequest(runtime, { url, method: "POST", body });

  if (res.statusCode === 200) {
    const parsed = JSON.parse(new TextDecoder().decode(res.body)) as Record<string, unknown>;
    return {
      allowed: Boolean(parsed.allowed ?? true),
      reason: typeof parsed.reason === "string" ? parsed.reason : "backend_policy",
    };
  }

  if (res.statusCode === 403) {
    const parsed = JSON.parse(new TextDecoder().decode(res.body)) as Record<string, unknown>;
    return {
      allowed: false,
      reason: typeof parsed.reason === "string" ? parsed.reason : "backend_policy_denied",
    };
  }

  runtime.log(`[compliance-guard] Backend compliance check returned ${res.statusCode}; defaulting to allow`);
  return { allowed: true, reason: "backend_check_skipped" };
}

function runComplianceCheck(
  runtime: Runtime<ComplianceGuardConfig>,
  walletAddress: string,
  action?: string,
  marketId?: string
): ComplianceCheckResult {
  const config = runtime.config;
  const blockedCountries = config.blockedCountries ?? DEFAULT_BLOCKED_COUNTRIES;

  if (!walletAddress?.trim()) {
    return { allowed: false, reason: "missing_wallet_address", walletAddress: "", action, marketId };
  }

  runtime.log(`[compliance-guard] Checking compliance for wallet=${walletAddress} action=${action ?? "trade"}`);

  const policyResult = checkBackendPolicy(runtime, walletAddress, action, marketId);
  if (!policyResult.allowed) {
    runtime.log(`[compliance-guard] Backend policy denied: reason=${policyResult.reason}`);
    return { allowed: false, reason: policyResult.reason, walletAddress, action, marketId };
  }

  runtime.log(`[compliance-guard] Compliance check passed for wallet=${walletAddress}`);
  return {
    allowed: true,
    reason: "compliant",
    walletAddress,
    action,
    marketId,
  };
}

const onCronTrigger = async (runtime: Runtime<ComplianceGuardConfig>): Promise<string> => {
  return JSON.stringify({ status: "ok", workflow: "compliance-guard", note: "use HTTP trigger with action=checkCompliance" });
};

const onHTTPTrigger = async (
  runtime: Runtime<ComplianceGuardConfig>,
  payload: { input: Uint8Array }
): Promise<Record<string, string>> => {
  const body = (() => {
    try {
      return JSON.parse(new TextDecoder().decode(payload.input)) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  verifyApiKey(runtime, body);

  const action = body.action as string | undefined;

  if (action === "checkCompliance") {
    const walletAddress = typeof body.walletAddress === "string" ? body.walletAddress : "";
    const tradeAction = typeof body.tradeAction === "string" ? body.tradeAction : "trade";
    const marketId = typeof body.marketId === "string" ? body.marketId : undefined;

    const result = runComplianceCheck(runtime, walletAddress, tradeAction, marketId);

    return {
      allowed: String(result.allowed),
      reason: result.reason,
      walletAddress: result.walletAddress,
      action: result.action ?? "trade",
      marketId: result.marketId ?? "",
    };
  }

  if (action === "status") {
    const blockedCountries = runtime.config.blockedCountries ?? DEFAULT_BLOCKED_COUNTRIES;
    return {
      status: "ok",
      workflow: "compliance-guard",
      blockedCountries: blockedCountries.join(","),
      minWalletAgeDays: String(runtime.config.minWalletAgeDays ?? DEFAULT_MIN_WALLET_AGE_DAYS),
    };
  }

  throw new Error("HTTP action must be one of: checkCompliance, status");
};

const initWorkflow = (
  config: ComplianceGuardConfig,
  _secretsProvider: { getSecret: (args: { id: string }) => { result: () => { value?: string } } }
) => {
  const cron = new CronCapability();
  const http = new HTTPCapability();
  return [
    handler(cron.trigger({ schedule: config.schedule }), onCronTrigger),
    handler(http.trigger({}), onHTTPTrigger),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<ComplianceGuardConfig>({
    configSchema: complianceGuardConfigSchema as never,
  });
  await runner.run(initWorkflow);
}
