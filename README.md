# Sub0 CRE – Onchain Cal Workflows

> Chainlink Runtime Environment (CRE) workflows for Sub0 prediction markets: market creation, LMSR pricing, quote signing, confidential trades, and liquidity seeding on Base Sepolia.

---

## Table of contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Project setup](#project-setup)
- [Scripts and commands](#scripts-and-commands)
- [Project structure](#project-structure)
- [Configuration](#configuration)
- [Workflow actions](#workflow-actions)
- [Essential implementation](#essential-implementation)
- [Secrets and environment](#secrets-and-environment)

---

## Overview

| Item              | Description                                       |
| ----------------- | ------------------------------------------------- |
| **Project**       | `onchain-cal` – CRE TypeScript workflows for Sub0 |
| **Chain**         | Base Sepolia (ethereum-testnet-sepolia-base-1)    |
| **Workflow name** | `markets` (entry: `markets/main.ts`)              |
| **Triggers**      | HTTP, Cron                                        |

The workflow compiles to WebAssembly and runs via the CRE CLI. It supports HTTP-triggered actions (create market, seed, quote, order, LMSR pricing, create agent key) and an optional cron trigger for platform tasks.

---

## Prerequisites

| Requirement       | Notes                                                  |
| ----------------- | ------------------------------------------------------ |
| **Bun**           | v1.2.21+ (`bun --version`)                             |
| **CRE CLI**       | Installed and logged in (`cre whoami`, `cre login`)    |
| **Funded wallet** | Base Sepolia ETH for writes (e.g. create market, seed) |

---

## Project setUp (Easy)

## Project setup

### 1. Clone and enter project

```bash
cd sub0cre
```

### 2. Install workflow dependencies

From the **project root** (`sub0cre`):

```bash
just install
```

or using bun

```bash
bun install --cwd ./markets
```

### 3. Environment and secrets

Clone `.env.example` to `.env` file in the project root (see [Secrets and environment](#secrets-and-environment)). Required for simulation and onchain writes:

- `CRE_ETH_PRIVATE_KEY` – signer for platform writes (create market, seed)
- `CRE_TARGET` – optional; e.g. `staging-settings`
- `BACKEND_SIGNER_PRIVATE_KEY` – DON signer for LMSR quotes (namespace `sub0`)
- `HTTP_API_KEY` – optional; required if set in secrets for HTTP trigger

### 4. Verify setup

```bash
cre workflow simulate markets --target staging-settings
```

After compilation you should see the trigger selection prompt. Use Ctrl+C to exit.

---

## Scripts and commands

### Example: simulate with payload

```bash
# Create market (from project root)
just sim-create

## using cre
cre workflow simulate markets --non-interactive --trigger-index 1 \
  --http-payload @../payloads/create-market-payload.json \
  --target staging-settings --broadcast

# Seed liquidity
just sim-seed

## using cre
cre workflow simulate markets --non-interactive --trigger-index 1 \
  --http-payload @../payloads/seed-payload.json \
  --target staging-settings --broadcast

# LMSR pricing
just sim-lmsr

## using cre
cre workflow simulate markets --non-interactive --trigger-index 1 \
  --http-payload @../payloads/lmsr-pricing-payload.json \
  --target staging-settings
```

Payload files live under `payloads/` (e.g. `create-market-payload.json`, `seed-payload.json`, `lmsr-pricing-payload.json`, `quote-payload.json`, `buy-payload.json`, `create-agent-key-payload.json`).

### CRE CLI (run from project root)

| Command                                                                                                                               | Description                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `cre workflow simulate markets --target staging-settings`                                                                             | Compile and run workflow; interactive trigger selection        |
| `cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/<file>.json --target staging-settings` | Run HTTP trigger with a JSON payload file                      |
| `cre workflow simulate markets --broadcast --target staging-settings`                                                                 | Same as above but broadcast real onchain transactions          |
| `cre workflow deploy markets --target staging-settings`                                                                               | Deploy workflow to the registry                                |
| `cre workflow activate markets --target staging-settings`                                                                             | Activate workflow on the registry                              |
| `cre secrets create ...`                                                                                                              | Create secrets for the workflow (e.g. backend signer, API key) |

---

## Project structure

```
onchain-cal/
├── .env                    # Secrets (do not commit)
├── .gitignore
├── project.yaml            # RPC and project-wide settings
├── secrets.yaml            # Secret name declarations
├── contracts.json          # Contract addresses per target
├── README.md
├── payloads/              # HTTP payloads for simulation
│   ├── create-market-payload.json
│   ├── seed-payload.json
│   ├── lmsr-pricing-payload.json
│   ├── quote-payload.json
│   ├── buy-payload.json
│   ├── sell-payload.json
│   ├── create-agent-key-payload.json
│   └── execute-confidential-trade-payload.json
├── markets/                # Single workflow: "markets"
│   ├── main.ts             # Entry point (Cron + HTTP handlers)
│   ├── package.json
│   ├── tsconfig.json
│   ├── workflow.yaml       # Workflow name and artifacts
│   ├── config.staging.json
│   ├── config.production.json
│   ├── lib/                # Shared logic
│   │   ├── abis.ts         # ABI exports from lib/abi/*.json
│   │   ├── abi/            # sub0, predictionVault, conditionalToken ABIs
│   │   ├── evm.ts          # EVM client and call helpers
│   │   ├── sub0.ts         # Sub0 create/getMarket, computeQuestionId
│   │   ├── predictionVault.ts  # getConditionId, signLMSRQuote, seed, executeTrade
│   │   ├── ctf.ts          # ConditionalTokens (balance, collectionId, positionId)
│   │   ├── lmsrMath.ts     # LMSR cost (decimal.js)
│   │   ├── signTypedDataSync.ts  # Sync EIP-712 signer (WASM-safe)
│   │   ├── createWalletSync.ts   # Sync wallet creation (no ethers)
│   │   └── httpMiddleware.ts     # API key verification
│   ├── workflows/          # Handlers
│   │   ├── platformActions.ts    # createMarket, seed, cron
│   │   ├── quoteSigning.ts       # quote / order
│   │   ├── lmsrPricing.ts        # lmsrPricing
│   │   ├── createAgentKey.ts     # createAgentKey
│   │   └── executeConfidentialTrade.ts  # Standalone (async)
│   └── types/              # Shared types (config, market, quote, etc.)
└── md/                     # Extra docs (e.g. confidential-workflows, http)
```

---

## Configuration

### Targets

Defined in `project.yaml` and `markets/workflow.yaml`.

| Target                | Use                                                         |
| --------------------- | ----------------------------------------------------------- |
| `staging-settings`    | Staging RPC and workflow name (e.g. `cal-workflow-staging`) |
| `production-settings` | Production (same RPC in current example)                    |

Select with `--target staging-settings` or `CRE_TARGET=staging-settings`.

### RPC

In `project.yaml`:

```yaml
staging-settings:
  rpcs:
    - chain-name: ethereum-testnet-sepolia-base-1
      url: https://sepolia.base.org
```

### Workflow artifacts (`markets/workflow.yaml`)

- **workflow-path**: `./main.ts`
- **config-path**: `./config.staging.json` or `./config.production.json`
- **secrets-path**: `""` (secrets loaded from `.env` or CRE secrets)

Contract addresses and EIP-712 settings come from the config JSON (e.g. `config.staging.json`), which can be wired from `contracts.json` or maintained per environment.

---

## Workflow actions

HTTP trigger expects a JSON body with `action` and, when applicable, `apiKey`.

| Action            | Description                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMarket`    | Sub0 `create(Market)`; returns `questionId` and full market from `getMarket`. Requires `creatorAddress` in payload. Optional `amountUsdc` + same creator runs seed after create.         |
| `seed`            | PredictionVault `seedMarketLiquidity(questionId, amountUsdc)`. Requires `questionId` and `amountUsdc` in payload.                                                                        |
| `quote` / `order` | Sign LMSR quote (EIP-712) for `executeTrade`. Uses backend signer from secrets. Payload: `questionId`, `outcomeIndex`, `buy`, `quantity`, `tradeCostUsdc`, `nonce`, `deadline`.          |
| `lmsrPricing`     | DON computes LMSR cost from on-chain balances, signs quote. Payload: `marketId`, `outcomeIndex`, `quantity`, `bParameter`. Returns `tradeCostUsdc`, `donSignature`, `deadline`, `nonce`. |
| `createAgentKey`  | Generate agent wallet in enclave (sync); returns `address` only. Payload: `agentId`.                                                                                                     |

**Confidential trade** (executeConfidentialTrade) is a **standalone** workflow entrypoint (`markets/executeConfidentialTrade.ts`), not exposed as an action in `main.ts`, due to async signing. Use the dedicated entrypoint and payload `execute-confidential-trade-payload.json` when integrating with the confidential flow.

---

## Essential implementation

### Entry and routing

- **`markets/main.ts`**: Registers Cron and HTTP triggers. HTTP handler parses `body.action`, verifies API key when configured, then delegates to the correct handler (quoteSigning, lmsrPricing, createAgentKey, platformActions).

### Platform (create market, seed)

- **`workflows/platformActions.ts`**: `handleCreateMarket` computes `questionId` with `keccak256(abi.encodePacked(question, creator, oracle))`, calls Sub0 `create(Market)`, optionally runs seed, then calls Sub0 `getMarket(questionId)` and returns all market fields plus tx hashes. `handleSeedLiquidity` encodes and submits `seedMarketLiquidity`.

### Agent and DON signing

- **`lib/predictionVault.ts`**: `signLMSRQuote` uses sync EIP-712 signer (`lib/signTypedDataSync.ts`) so the main workflow stays WASM-safe. `encodeExecuteTrade` / `submitExecuteTrade` use the contract’s flat signature (questionId, outcomeIndex, buy, quantity, tradeCostUsdc, maxCostUsdc, nonce, deadline, user, donSignature, userSignature).

- **`workflows/quoteSigning.ts`**: Loads backend signer from secrets, fetches market and vault state, then signs the quote and returns the signed payload.

- **`workflows/lmsrPricing.ts`**: Fetches on-chain outcome balances, computes LMSR cost with `decimal.js`, gets a nonce, signs with DON signer, returns cost and signature.

### ABIs and contracts

- **`lib/abis.ts`**: Re-exports ABIs from `lib/abi/sub0.json`, `lib/abi/predictionVault.json`, `lib/abi/conditionalToken.json` for Sub0, PredictionVault, and ConditionalTokens.

- **EVM reads**: `lib/evm.ts` provides `callContract`, `decodeCallResult`, `buildCallData`. Sub0, PredictionVault, and CTF reads use these with the shared ABIs.

### Sync-only and WASM

- Signing and key generation in the main workflow path use sync implementations (`signTypedDataSync`, `createWalletSync`) to avoid WASM “unreachable” issues with async or heavy deps in the compiled bundle.

---

## Secrets and environment

### Required for simulation and writes

| Variable                     | Purpose                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `CRE_ETH_PRIVATE_KEY`        | Platform signer (create market, seed). Must have Sub0/PredictionVault roles as required by contracts. |
| `BACKEND_SIGNER_PRIVATE_KEY` | DON/backend signer for LMSR quotes (EIP-712). Must match PredictionVault’s `backendSigner`.           |
| `CRE_TARGET`                 | Optional; default target (e.g. `staging-settings`).                                                   |

### Optional

| Variable       | Purpose                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------- |
| `HTTP_API_KEY` | If set in secrets (e.g. namespace `sub0`), HTTP trigger requires `body.apiKey` to match. |

### Declarations

`secrets.yaml` declares logical names (e.g. `BACKEND_SIGNER_PRIVATE_KEY`, `HTTP_API_KEY`). For local simulation, set values in `.env`. For deployed workflows, use `cre secrets create` and reference the same names.

---

## References

- [CRE Documentation](https://docs.chain.link/cre)
- [Simulating Workflows](https://docs.chain.link/cre/guides/operations/simulating-workflows)
- Project docs in `md/` (e.g. `md/confidential-workflows.cre.md`, `md/workflows.http.md`)
