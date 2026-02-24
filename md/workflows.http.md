# Backend HTTP Trigger Report: Sub0 CRE Workflows

This report describes how the backend triggers CRE workflows via HTTP. All triggers use the same deployed workflow HTTP endpoint and a JSON request body.

---

## 1. Overview

| Action        | Purpose                                      | Caller / key used                          |
|---------------|----------------------------------------------|--------------------------------------------|
| `createMarket`| Create market onchain and optionally seed    | Platform (env key: CRE_ETH_PRIVATE_KEY)    |
| `quote` / `order` | Get signed quote for executeTrade        | Agent / users (secret: BACKEND_SIGNER_PRIVATE_KEY) |
| `seed`        | Seed market liquidity (USDC to outcome set) | Platform (env key: CRE_ETH_PRIVATE_KEY)    |

**Endpoint:** `POST <CRE_WORKFLOW_HTTP_URL>`  
**Content-Type:** `application/json`

**Authentication:** If the CRE secret `HTTP_API_KEY` (namespace `sub0`) is set, every request body must include a matching `apiKey` field. If the secret is not set, `apiKey` is ignored.

---

## 2. Common Request Shape

Every request is a JSON object. The field `action` selects the workflow.

```json
{
  "action": "createMarket",
  "apiKey": "your-api-key-if-configured"
}
```

Additional fields depend on `action` (see sections below).

---

## 3. createMarket

Creates a market onchain via `Sub0.create(Market)`. Optionally runs the seed workflow in the same request when `amountUsdc` and `creatorAddress` are provided.

### Request

| Field              | Type   | Required | Description |
|--------------------|--------|----------|-------------|
| `action`           | string | Yes      | `"createMarket"` |
| `apiKey`           | string | If secret set | Same value as CRE secret `HTTP_API_KEY` |
| `question`         | string | Yes      | Market question text |
| `oracle`           | string | Yes      | Oracle address (0x + 40 hex chars) |
| `duration`         | number | Yes      | Market duration (e.g. seconds until close) |
| `outcomeSlotCount` | number | Yes      | Number of outcomes (2–255) |
| `oracleType`       | number | Yes      | 1 = PLATFORM, 2 = ARBITRATOR, 3 = CUSTOM |
| `marketType`       | number | Yes      | 0 = Single, 1 = Group, 2 = Public |
| `amountUsdc`       | string | No       | If set with `creatorAddress`, seed runs after create (USDC 6 decimals) |
| `creatorAddress`   | string | No       | Address that signs the create tx; required with `amountUsdc` for seed |

### Example

```json
{
  "action": "createMarket",
  "apiKey": "your-api-key",
  "question": "Will X happen by 2025-12-31?",
  "oracle": "0x3BF6B67DEFf0e568C4eac4d766FD844BA305d16B",
  "duration": 86400,
  "outcomeSlotCount": 2,
  "oracleType": 1,
  "marketType": 2,
  "amountUsdc": "1000000",
  "creatorAddress": "0xf0830060f836B8d54bF02049E5905F619487989e"
}
```

### Response

```json
{
  "status": "ok",
  "result": "createMarket"
}
```

### Notes

- The wallet in `.env` (`CRE_ETH_PRIVATE_KEY`) is the transaction signer and becomes the market owner.
- For Public markets (`marketType: 2`), that wallet must have `GAME_CREATOR_ROLE` on the PermissionManager.
- When both `amountUsdc` and `creatorAddress` are set, CRE computes `questionId = keccak256(abi.encodePacked(question, creatorAddress, oracle))` and calls `PredictionVault.seedMarketLiquidity(questionId, amountUsdc)` after create. `creatorAddress` must be the same as the create tx signer.

---

## 4. executeTrades (quote / order)

Used by agents or users to obtain a signed LMSR quote. The backend then calls `PredictionVault.executeTrade(..., signature)` onchain (or returns the quote to the client to do so).

Use either `action: "quote"` or `action: "order"`; both use the same handler.

### Request

| Field          | Type   | Required | Description |
|----------------|--------|----------|-------------|
| `action`       | string | Yes      | `"quote"` or `"order"` |
| `apiKey`       | string | If secret set | Same value as CRE secret `HTTP_API_KEY` |
| `questionId`   | string | Yes      | Market identifier (0x + 64 hex chars) |
| `outcomeIndex` | number | Yes      | Zero-based outcome index |
| `buy`          | boolean| Yes      | `true` = user buys outcome tokens |
| `quantity`     | string | Yes      | Outcome token amount (18 decimals) |
| `tradeCostUsdc`| string | Yes      | USDC amount user pays (buy) or receives (sell), 6 decimals |
| `nonce`        | string | Yes      | Unique per-market nonce (not yet used) |
| `deadline`     | string | Yes      | Unix timestamp after which quote is invalid |

### Example

```json
{
  "action": "order",
  "apiKey": "your-api-key",
  "questionId": "0x1234...",
  "outcomeIndex": 0,
  "buy": true,
  "quantity": "1000000000000000000",
  "tradeCostUsdc": "500000",
  "nonce": "1",
  "deadline": "1735689600"
}
```

### Response

CRE returns the signed quote (EIP-712). Use these values to call `PredictionVault.executeTrade` onchain.

```json
{
  "questionId": "0x...",
  "outcomeIndex": 0,
  "buy": true,
  "quantity": "1000000000000000000",
  "tradeCostUsdc": "500000",
  "nonce": "1",
  "deadline": "1735689600",
  "signature": "0x..."
}
```

### Notes

- CRE validates market exists, outcome index, nonce not used, and (for buys) vault balance.
- Signing uses the CRE secret `BACKEND_SIGNER_PRIVATE_KEY` (namespace `sub0`); the corresponding address must match `PredictionVault.backendSigner()`.

---

## 5. seed

Seeds liquidity for an existing market: sends USDC to the vault and mints a full outcome set via ConditionalTokens.

### Request

| Field        | Type   | Required | Description |
|--------------|--------|----------|-------------|
| `action`     | string | Yes      | `"seed"` |
| `apiKey`     | string | If secret set | Same value as CRE secret `HTTP_API_KEY` |
| `questionId` | string | Yes      | Market identifier (0x + 64 hex chars) |
| `amountUsdc` | string | Yes      | USDC amount (6 decimals) |

### Example

```json
{
  "action": "seed",
  "apiKey": "your-api-key",
  "questionId": "0x1234...",
  "amountUsdc": "5000000"
}
```

### Response

```json
{
  "status": "ok"
}
```

### Notes

- The env key (`CRE_ETH_PRIVATE_KEY`) must be the PredictionVault owner.
- Market must already exist and be registered (e.g. created via `createMarket` or Sub0 frontend).

---

## 6. All Workflows Summary

| action       | Description                              | Key / secret used                    |
|-------------|------------------------------------------|--------------------------------------|
| `createMarket` | Sub0.create(Market); optional seed after | CRE_ETH_PRIVATE_KEY (platform)       |
| `quote`     | Sign LMSR quote for executeTrade         | BACKEND_SIGNER_PRIVATE_KEY (secret)  |
| `order`     | Same as `quote` (alias)                  | BACKEND_SIGNER_PRIVATE_KEY (secret)  |
| `seed`      | PredictionVault.seedMarketLiquidity      | CRE_ETH_PRIVATE_KEY (platform)       |

---

## 7. Errors

- **Unauthorized: invalid or missing apiKey** – `HTTP_API_KEY` is set in CRE but body `apiKey` is missing or does not match.
- **Missing config.contracts** – Workflow config has no contract addresses for the target.
- **Market not found / outcome index / nonce / vault balance** – Validation errors in quote/order flow.
- **question / duration / oracle / outcomeSlotCount / creatorAddress** – Validation errors in createMarket or seed.

All errors are returned by the CRE runtime; the backend should map them to appropriate HTTP status codes (e.g. 401 for Unauthorized, 400 for validation).

---

## 8. Backend Integration Checklist

1. Obtain the CRE workflow HTTP URL after deployment (`cre workflow deploy cal-workflow --target <target>`).
2. If API key is enabled, set CRE secret `HTTP_API_KEY` (namespace `sub0`) and send the same value in every request as `body.apiKey`.
3. **createMarket:** Send market fields; optionally include `amountUsdc` and `creatorAddress` to run seed in the same request. Use the same wallet as `CRE_ETH_PRIVATE_KEY` for `creatorAddress` when seeding.
4. **executeTrades:** Use `action: "quote"` or `"order"` with quote params; use the returned `signature` (and other fields) to call `PredictionVault.executeTrade(...)` onchain.
5. **seed:** Call with `questionId` and `amountUsdc` when the platform wants to add liquidity to an existing market.
