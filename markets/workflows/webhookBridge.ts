/**
 * Webhook Bridge workflow — EVM_LOG triggered direct frontend notification.
 *
 * Listens to any major on-chain event (configurable) and forwards the event
 * payload to both the backend `/api/internal/cre/webhook-event` endpoint
 * (for WebSocket broadcast to all connected clients) and optionally to a
 * direct frontend webhook URL (bypasses backend when needed).
 *
 * This creates a direct CRE → frontend notification path so the UI can
 * react to on-chain events without polling.
 *
 * Config flags: frontendWebhookEnabled, frontendWebhookUrl
 *
 * EVM_LOG trigger: any configurable contract event (default: AnyMajorEvent)
 * HTTP action: "webhookForward" — body: { action, eventType, payload }
 *
 * Backend endpoints:
 *   POST /api/internal/cre/webhook-event    — persist + WS broadcast
 */

import type { Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "../types/config";
import { sendConfidentialBackendRequest } from "../lib/confidentialHttp";

const WEBHOOK_EVENT_PATH = "/api/internal/cre/webhook-event";

interface WebhookForwardPayload {
  eventType: string;
  contractAddress?: string | null;
  blockNumber?: number | null;
  txHash?: string | null;
  data: Record<string, unknown>;
  forwardedAt: string;
}

function buildEventPayload(
  eventType: string,
  rawPayload: Record<string, unknown>
): WebhookForwardPayload {
  return {
    eventType,
    contractAddress: typeof rawPayload.address === "string" ? rawPayload.address : null,
    blockNumber: typeof rawPayload.blockNumber === "number" ? rawPayload.blockNumber : null,
    txHash: typeof rawPayload.transactionHash === "string" ? rawPayload.transactionHash : null,
    data: rawPayload,
    forwardedAt: new Date().toISOString(),
  };
}

function forwardToBackend(
  runtime: Runtime<WorkflowConfig>,
  payload: WebhookForwardPayload
): void {
  const backendUrl = runtime.config.backendUrl?.trim() ?? "";
  if (!backendUrl) return;
  const url = `${backendUrl.replace(/\/$/, "")}${WEBHOOK_EVENT_PATH}`;
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const res = sendConfidentialBackendRequest(runtime, { url, method: "POST", body });
  runtime.log(`[webhook-bridge] backend forward eventType=${payload.eventType} status=${res.statusCode}`);
}

function forwardToFrontendWebhook(
  runtime: Runtime<WorkflowConfig>,
  payload: WebhookForwardPayload
): void {
  const webhookUrl = runtime.config.frontendWebhookUrl?.trim() ?? "";
  if (!webhookUrl || !runtime.config.frontendWebhookEnabled) return;
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const res = sendConfidentialBackendRequest(runtime, { url: webhookUrl, method: "POST", body });
  runtime.log(`[webhook-bridge] frontend webhook forward eventType=${payload.eventType} url=${webhookUrl} status=${res.statusCode}`);
}

export function handleWebhookBridgeEvmLog(
  runtime: Runtime<WorkflowConfig>,
  eventPayload: Record<string, unknown>
): Record<string, string> {
  const eventType = typeof eventPayload.event === "string" ? eventPayload.event : "onchainEvent";
  const payload = buildEventPayload(eventType, eventPayload);

  forwardToBackend(runtime, payload);
  forwardToFrontendWebhook(runtime, payload);

  return {
    status: "ok",
    trigger: "evmLog",
    eventType,
    forwardedAt: payload.forwardedAt,
    frontendWebhook: String(!!runtime.config.frontendWebhookEnabled),
  };
}

export function handleWebhookBridgeHttp(
  runtime: Runtime<WorkflowConfig>,
  body: Record<string, unknown>
): Record<string, string> {
  if (body.action !== "webhookForward") {
    throw new Error("HTTP action must be: webhookForward");
  }
  const eventType = typeof body.eventType === "string" ? body.eventType.trim() : "manualEvent";
  const rawData = typeof body.payload === "object" && body.payload !== null
    ? (body.payload as Record<string, unknown>)
    : {};

  const payload = buildEventPayload(eventType, rawData);
  forwardToBackend(runtime, payload);
  forwardToFrontendWebhook(runtime, payload);

  return {
    status: "ok",
    action: "webhookForward",
    eventType,
    forwardedAt: payload.forwardedAt,
    frontendWebhook: String(!!runtime.config.frontendWebhookEnabled),
  };
}
