# Backend: CRE Workflow Payloads, Responses, and Endpoints

This document describes (1) what payload the backend sends to the CRE workflow HTTP trigger, (2) what response the backend gets back, and (3) which backend endpoints receive POST callbacks from CRE when `config.backendUrl` is set.

All requests to CRE are HTTP POST to the CRE workflow trigger. The body must be JSON and must include `action` to select the workflow. Optional: `apiKey` when the workflow expects HTTP API key auth.

---

## 1. Payloads to send to CRE (request body)

### 1.1 quote / order

Sign an LMSR quote for PredictionVault.executeTrade (EIP-712). Same payload for both `action: "quote"` and `action: "order"`.

| Field         | Type    | Required | Description |
|---------------|---------|----------|-------------|
| action        | string  | yes      | `"quote"` or `"order"` |
| questionId    | string  | yes      | Market question ID (32-byte hex) |
| conditionId   | string  | yes      | Condition ID (hex) |
| outcomeIndex  | number  | yes      | Outcome index (0-based) |
| buy           | boolean | yes      | true = buy, false = sell |
| quantity      | string  | yes      | Share quantity (decimal string) |
| tradeCostUsdc | string  | yes      | Trade cost in USDC units (decimal string) |
| nonce         | string  | yes      | User nonce for this market |
| deadline      | string  | yes      | EIP-712 deadline (unix timestamp string) |

### 1.2 buy / sell

Same as quote/order; CRE forces `buy: true` for `action: "buy"` and `buy: false` for `action: "sell"`. Send the same fields as quote; do not rely on body.buy for buy/sell (action overrides).

| Field         | Type    | Required | Description |
|---------------|---------|----------|-------------|
| action        | string  | yes      | `"buy"` or `"sell"` |
| questionId    | string  | yes      | As in quote |
| conditionId   | string  | yes      | As in quote |
| outcomeIndex  | number  | yes      | As in quote |
| quantity      | string  | yes      | As in quote |
| tradeCostUsdc | string  | yes      | As in quote |
| nonce         | string  | yes      | As in quote |
| deadline      | string  | yes      | As in quote |

### 1.3 lmsrPricing

DON computes LMSR cost from on-chain state and signs the quote.

| Field        | Type   | Required | Description |
|--------------|--------|----------|-------------|
| action       | string | yes      | `"lmsrPricing"` |
| marketId     | string | yes      | Market/question ID (32-byte hex) |
| outcomeIndex | number | yes      | Outcome index (0-based) |
| quantity     | string | yes      | Share quantity (decimal string) |
| bParameter   | string | no       | LMSR b parameter (default `"1"`). Can be sent as `b`. |

### 1.4 createAgentKey

Generate an agent wallet in the enclave; CRE optionally encrypts the key and signs ETH transfer plus ERC20/CT approves. CRE also POSTs the result to the backend at `/api/cre/agent-keys` (see section 2).

| Field        | Type   | Required | Description |
|--------------|--------|----------|-------------|
| action       | string | yes      | `"createAgentKey"` |
| agentId      | string | yes      | Unique agent identifier |
| funderNonce  | number | no       | Current nonce for BACKEND_SIGNER_PRIVATE_KEY (from eth_getTransactionCount). If omitted and config.rpcUrl is set, CRE fetches it. |
| entropy      | string | no       | Optional hex entropy so each run yields a different address (e.g. when RNG is deterministic). |

### 1.5 stake

Submit a stake via Sub0 CRE (0x02). Forwarder stakes on behalf of owner.

| Field              | Type           | Required | Description |
|--------------------|----------------|----------|-------------|
| action             | string         | yes      | `"stake"` |
| questionId         | string         | yes      | Question ID (32-byte hex) |
| parentCollectionId | string         | no       | Default all-zero bytes32 |
| partition          | string[]       | yes      | Partition (array of outcome indices) |
| token              | string         | yes      | Token address (e.g. USDC) |
| amount             | string         | yes      | Amount (decimal string) |
| owner               | string         | yes      | Owner address (0x...) |

### 1.6 redeem

Submit a redeem via Sub0 CRE (0x03). Owner must supply EIP-712 signature.

| Field              | Type   | Required | Description |
|--------------------|--------|----------|-------------|
| action             | string | yes      | `"redeem"` |
| parentCollectionId | string | yes      | Parent collection ID (bytes32 hex) |
| conditionId        | string | yes      | Condition ID (bytes32 hex) |
| indexSets          | array  | yes      | Index sets (string or number array) |
| token              | string | yes      | Token address |
| owner              | string | yes      | Owner address |
| deadline           | string | yes      | EIP-712 deadline (string) |
| nonce              | string | yes      | Redeem nonce from contract |
| signature          | string | yes      | EIP-712 signature (0x-prefixed hex) |

### 1.7 executeConfidentialTrade / execute-confidential-trade

Dual-signature trade: DON signs with BACKEND_SIGNER_PRIVATE_KEY; user signs with agent key (fetched by agentId from secrets). CRE submits executeTrade and returns txHash.

| Field          | Type   | Required | Description |
|----------------|--------|----------|-------------|
| action         | string | yes      | `"executeConfidentialTrade"` or `"execute-confidential-trade"` |
| agentId        | string | yes      | Secret id holding the agent private key |
| marketId       | string | yes      | Market/question ID (or use questionId) |
| outcomeIndex   | number | yes      | Outcome index |
| buy            | boolean| yes      | true = buy, false = sell |
| quantity       | string | yes      | Share quantity |
| tradeCostUsdc  | string | yes      | Trade cost USDC |
| nonce          | string | yes      | Nonce for this market |
| deadline       | string | yes      | Deadline (string) |

### 1.8 createMarket

Create a market via Sub0 CRE (0x00).

| Field           | Type   | Required | Description |
|-----------------|--------|----------|-------------|
| action          | string | yes      | `"createMarket"` |
| question        | string | yes      | Market question text |
| oracle          | string | yes      | Oracle address |
| duration        | number | yes      | Duration (e.g. seconds) |
| outcomeSlotCount| number | yes      | Number of outcomes (e.g. 2) |
| oracleType      | number | yes      | 1=PLATFORM, 2=ARBITRATOR, 3=CUSTOM |
| marketType      | number | yes      | 0=Single, 1=Group, 2=Public |
| creatorAddress  | string | yes      | Creator address (for questionId) |
| amountUsdc      | string | no       | If set, seed workflow can run after create |

### 1.9 getMarket

Read market by questionId.

| Field      | Type   | Required | Description |
|------------|--------|----------|-------------|
| action     | string | yes      | `"getMarket"` |
| questionId | string | yes      | Market question ID (32-byte hex) |

### 1.10 seed

Seed market liquidity via PredictionVault CRE (0x01).

| Field       | Type   | Required | Description |
|-------------|--------|----------|-------------|
| action      | string | yes      | `"seed"` |
| questionId  | string | yes      | Market question ID |
| amountUsdc  | string | yes      | USDC amount (decimal string) |

### 1.11 resolveMarket

Resolve a market via Sub0 CRE.

| Field      | Type   | Required | Description |
|------------|--------|----------|-------------|
| action     | string | yes      | `"resolveMarket"` |
| questionId | string | yes      | Market question ID |
| payouts    | string[] | yes    | Payout vector (one per outcome, decimal strings) |
| oracle     | string | yes      | Oracle address |

### 1.12 approveErc20

Sign an ERC20 approve tx (optionally broadcast). Backend can use agent or backend signer.

| Field      | Type   | Required | Description |
|------------|--------|----------|-------------|
| action     | string | yes      | `"approveErc20"` |
| signer     | string | yes      | `"agent"` or `"backend"` |
| agentId    | string | cond.    | Required when signer is `"agent"` |
| token      | string | no       | Token address (default config USDC) |
| spender    | string | yes      | Spender address (e.g. PredictionVault) |
| amount     | string | yes      | Allowance (wei string) |
| nonce      | string | no       | Signer nonce (recommended for broadcast) |
| userInvoke | boolean| yes      | true = return signed tx for client to broadcast; false = workflow may broadcast |

### 1.13 approveConditionalToken

Sign a conditional token setApprovalForAll tx.

| Field           | Type    | Required | Description |
|-----------------|---------|----------|-------------|
| action          | string  | yes      | `"approveConditionalToken"` |
| signer          | string  | yes      | `"agent"` or `"backend"` |
| agentId         | string  | cond.    | Required when signer is `"agent"` |
| conditionalTokens | string| no       | Contract (default config) |
| operator        | string  | yes      | Operator address |
| approved        | boolean | yes      | true = approve, false = revoke |
| nonce           | string  | no       | Signer nonce |
| userInvoke      | boolean | no       | When false, returns signed tx for client to broadcast |

### 1.14 runSettlement

Run settlement for a market: fetch resolution from backend, encode report, writeReport, then POST resolved to backend.

| Field      | Type   | Required | Description |
|------------|--------|----------|-------------|
| action     | string | yes      | `"runSettlement"` |
| marketId   | string | yes      | Market identifier (for backend) |
| questionId | string | yes      | Onchain question ID (bytes32 hex) |

### 1.15 createMarketsFromBackend

CRE fetches agent markets from backend (GET), creates each on-chain, then POSTs onchain-created callback(s). Optional: send markets in body to skip GET.

| Field   | Type   | Required | Description |
|---------|--------|----------|-------------|
| action  | string | yes      | `"createMarketsFromBackend"` |
| apiKey  | string | no       | Backend API key (when not using vault) |
| markets | array  | no       | When set, CRE uses this list and does one batch POST instead of GET + per-market POSTs |

---

## 2. Responses from CRE (per action)

Responses are the HTTP response body from the CRE workflow (JSON). BigInt values are serialized as strings in the POST body CRE sends to the backend; the direct response to the caller may match.

### 2.1 quote / order / buy / sell

Signed EIP-712 quote (same shape for quote, order, buy, sell):

```json
{
  "questionId": "0x...",
  "outcomeIndex": 0,
  "buy": true,
  "quantity": "1000000000000000000",
  "tradeCostUsdc": "5000000",
  "nonce": "0",
  "deadline": "1735689600",
  "signature": "0x..."
}
```

### 2.2 lmsrPricing

```json
{
  "tradeCostUsdc": "5000000",
  "donSignature": "0x...",
  "deadline": "1735689600",
  "nonce": "0"
}
```

### 2.3 createAgentKey

```json
{
  "address": "0x...",
  "encryptedKeyBlob": "<base64url or empty if no TEE_MASTER_ENCRYPTION_KEY>",
  "signedEthTransfer": "0x...",
  "signedErc20": "0x...",
  "signedCT": "0x..."
}
```

`signedEthTransfer`, `signedErc20`, and `signedCT` are omitted if config/keys are missing. Backend should broadcast them in order (ETH transfer first, then approves).

### 2.4 stake / redeem

```json
{
  "status": "ok",
  "result": "stake",
  "txHash": "0x..."
}
```

Same shape for redeem with `"result": "redeem"`.

### 2.5 executeConfidentialTrade

```json
{
  "txHash": "0x..."
}
```

### 2.6 createMarket

Returns create-market result (e.g. questionId, createMarketTxHash, seedTxHash if seeded). Shape is workflow-specific.

### 2.7 getMarket

Returns market data (questionId, conditionId, outcomeSlotCount, supplies, etc.).

### 2.8 seed

Returns seed result (e.g. txHash).

### 2.9 resolveMarket

```json
{
  "status": "ok",
  "result": "resolveMarket",
  "txHash": "0x..."
}
```

### 2.10 approveErc20 / approveConditionalToken

```json
{
  "status": "ok",
  "result": "approveErc20",
  "signedTx": "0x...",
  "signerAddress": "0x...",
  "broadcastRequired": true
}
```

### 2.11 runSettlement

```json
{
  "status": "ok",
  "result": "runSettlement",
  "txHash": "0x...",
  "questionId": "0x..."
}
```

### 2.12 createMarketsFromBackend

Returns object with status, created count, and any errors.

---

## 3. Backend endpoints that receive POSTs from CRE

When `config.backendUrl` is set, CRE POSTs workflow results to these paths. The backend must implement them if it wants to receive callbacks. All are relative to `config.backendUrl` (e.g. `https://api.example.com`). Auth uses the same vault secret as createAgentKey (e.g. Basic or x-api-key from `BACKEND_API_VAR`).

| Method | Path | When CRE calls it | Body (summary) |
|--------|------|-------------------|----------------|
| POST   | `/api/cre/quote` | After quote or order | Signed quote (questionId, outcomeIndex, buy, quantity, tradeCostUsdc, nonce, deadline, signature) |
| POST   | `/api/cre/buy`   | After action buy    | Same as quote (buy = true) |
| POST   | `/api/cre/sell`  | After action sell   | Same as quote (buy = false) |
| POST   | `/api/cre/lmsr-pricing` | After lmsrPricing | tradeCostUsdc, donSignature, deadline, nonce |
| POST   | `/api/cre/stake`  | After stake         | status, result, txHash |
| POST   | `/api/cre/redeem` | After redeem        | status, result, txHash |
| POST   | `/api/cre/execute-confidential-trade` | After executeConfidentialTrade | txHash |
| POST   | `/api/cre/agent-keys` | After createAgentKey (always, from inside workflow) | agentId, address, encryptedKeyBlob, signedEthTransfer?, signedErc20?, signedCT? |

All bodies are JSON. BigInt values are stringified. The backend should respond with 2xx so CRE does not treat the callback as failed (CRE logs but does not fail the workflow on POST failure).

---

## 4. Summary table: action to backend callback path

| CRE action                  | Backend path CRE POSTs to              |
|----------------------------|----------------------------------------|
| quote, order               | /api/cre/quote                         |
| buy                        | /api/cre/buy                           |
| sell                       | /api/cre/sell                          |
| lmsrPricing                | /api/cre/lmsr-pricing                  |
| stake                      | /api/cre/stake                         |
| redeem                     | /api/cre/redeem                        |
| executeConfidentialTrade   | /api/cre/execute-confidential-trade   |
| createAgentKey             | /api/cre/agent-keys                    |

Other actions (createMarket, getMarket, seed, resolveMarket, approveErc20, approveConditionalToken, createMarketsFromBackend, runSettlement) do not trigger a separate CRE-to-backend POST for their result; the backend only gets the HTTP response from CRE when it invokes the workflow.
