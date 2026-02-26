# Sub0 CRE – Onchain Cal Workflows

> Chainlink Runtime Environment (CRE) workflows for Sub0 prediction markets: market creation, LMSR pricing, quote signing, confidential trades, and liquidity seeding on Base Sepolia.

---

## Table of contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Project setup](#project-setup)
- [Scripts and commands](#scripts-and-commands)
- [Docker (simulate gateway)](#docker-simulate-gateway)
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
| `cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/<file>.json --target staging-settings` | Run HTTP trigger with a JSON payload file (no real txs)        |
| `cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/<file>.json --target staging-settings --broadcast` | Same but broadcast real onchain transactions (required for create market to hit deployed Sub0) |
| `cre workflow deploy markets --target staging-settings`                                                                               | Deploy workflow to the registry                                |
| `cre workflow activate markets --target staging-settings`                                                                             | Activate workflow on the registry                              |
| `cre secrets create ...`                                                                                                              | Create secrets for the workflow (e.g. backend signer, API key) |

---

## Docker (simulate gateway)

To mimic a deployed CRE HTTP endpoint locally, run the workflow behind an HTTP server that runs `cre workflow simulate` per request:

1. **Build** (from repo root, context = `sub0cre`):

   ```bash
   cd sub0cre
   docker build -t sub0cre-gateway .
   ```

2. **CRE login (required):** The CLI must be logged in or simulate fails with "authentication required". Organization API keys are not widely available yet, so use browser-based login and mount your local credentials into the container:

   - On your **host** (where you have a browser), install the CRE CLI and run once:
     ```bash
     curl -sSL https://cre.chain.link/install.sh | bash
     cre login
     ```
     Complete the browser flow; credentials are stored under `~/.cre`.

   - Run the container with that directory mounted so the CLI inside the container can use your login. **Volume path by OS:**
     - **Linux:** `-v "$HOME/.cre:/root/.cre"` (e.g. `/home/you/.cre`)
     - **macOS:** `-v "$HOME/.cre:/root/.cre"` (e.g. `/Users/you/.cre`)
     - **Windows (PowerShell):** `-v "${env:USERPROFILE}\.cre:/root/.cre"` (e.g. `C:\Users\You\.cre`)
     - **Windows (Git Bash / WSL):** `-v "$HOME/.cre:/root/.cre"` as on Linux/macOS

   If you do have a CRE Organization API key, you can instead pass `-e CRE_API_KEY="your-key"` and omit the volume mount.

3. **Run** with secrets. You can either load all env from a file (no Infisical) or use Infisical.

   **Option A – All env from file (recommended for local/Docker):** Put all required vars in a `.env` file in `sub0cre` (see list below), then run:

   ```bash
   cd sub0cre
   docker run --rm --name sub0cre-gateway -p 8080:8080 \
     --add-host=host.docker.internal:host-gateway \
     -e CRE_TARGET=docker-settings \
     -v "$HOME/.cre:/root/.cre" \
     --env-file .env \
     sub0cre-gateway
   ```

   Do **not** set `INFISICAL_TOKEN` in that `.env`; the entrypoint will then run without Infisical and use only env from the container (your `--env-file` and `-e`). Required vars in `.env`: `CRE_ETH_PRIVATE_KEY`, `BACKEND_SIGNER_PRIVATE_KEY`, `BACKEND_API_KEY` (same value as backend `API_KEY`), `HTTP_API_KEY` (optional; match if CRE checks body.apiKey), `CRE_TARGET=docker-settings` (or pass `-e CRE_TARGET=docker-settings` to override). Optional: `CRE_API_KEY` if you use CRE CLI auth.

   **Option B – Infisical:** To load secrets from Infisical instead, set `-e INFISICAL_TOKEN=<token>` and do **not** pass `--env-file`. Ensure your Infisical path has secrets with **exact** names: `BACKEND_API_KEY`, `BACKEND_SIGNER_PRIVATE_KEY`, `HTTP_API_KEY`, `CRE_ETH_PRIVATE_KEY`, and optionally `CRE_API_KEY`. If names differ (e.g. only `CRE_ETH_PRIVATE_KEY` is set), the gateway will log "missing" for the others; use Option A or fix names in Infisical.

   Use both: `-e CRE_TARGET=docker-settings` and `--add-host=host.docker.internal:host-gateway` (required on Linux) so the workflow reaches the host backend. The container name is `sub0cre-gateway`; stop with `docker stop sub0cre-gateway`.

   **Troubleshooting:** If the workflow fails with `Get "http://host.docker.internal:4000/...": dial tcp: lookup host.docker.internal ... no such host`, the container cannot resolve the host. Add `--add-host=host.docker.internal:host-gateway` to your `docker run` (required on Linux).

   The gateway logs every request (path, action) and streams full `cre workflow simulate` stdout/stderr so workflow `runtime.log()` and errors appear in `docker logs`.

4. **Use from the backend:** Set `CRE_HTTP_URL=http://host:8080` (or `http://localhost:8080` if the server runs on the host). The backend can then call `POST /` (or `POST /trigger`) with the same JSON body it would send to a deployed CRE. The gateway runs `cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @file --target <CRE_TARGET>` and returns the workflow result as JSON.

5. **Health:** `GET /health` or `GET /` returns `{ "status": "ok", "service": "cre-simulate-gateway" }`.

6. **Broadcast:** The Docker image sets `CRE_GATEWAY_BROADCAST=true` by default so every request runs with `--broadcast` (real onchain txs and tx hashes). To dry-run without writing to chain, pass `-e CRE_GATEWAY_BROADCAST=false`. You can also send `"broadcast": true` in the JSON body when not using the Docker default.

After code or config changes, rebuild the image, then stop and run again: `docker stop sub0cre-gateway` (if it is running), then the same `docker run ...` command. Do not use `docker start sub0cre-gateway` after a rebuild — that starts the old container; you must run a new container from the new image.

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
├── gateway/               # HTTP server that runs simulate per request (Docker)
│   └── server.ts
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
| `staging-settings`    | Staging RPC; `config.staging.json` (backendUrl localhost:4000). |
| `docker-settings`     | Same RPC; `config.docker.json` (backendUrl host.docker.internal:4000). Use when the gateway runs in Docker so the workflow can reach the host backend. |
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
| `createMarketsFromBackend` | Fetches agent markets from backend `GET /api/internal/agent-markets`, creates each on-chain, then POSTs `questionId` + `createMarketTxHash` + `agentSource` to backend `POST /api/internal/markets/onchain-created`. Requires `config.backendUrl` and optional secret `BACKEND_API_KEY` (namespace `sub0`). |

### Why we fetch agent markets and use Confidential HTTP

- **Why fetch agent markets?** The backend is the source of "pending" markets to create: it stores agent-generated payloads (e.g. from Gemini/Grok or enqueued by users). The workflow does not invent markets; it asks the backend "what should I create?", then creates each on-chain and notifies the backend with `questionId` and tx hash. So the workflow must call the backend; the URL comes from `config.backendUrl` in the workflow config (e.g. `config.staging.json` or `config.docker.json`). The backend listens on **port 4000**; use `http://localhost:4000` for local runs and `http://host.docker.internal:4000` when the workflow runs inside Docker (see [Docker (simulate gateway)](#docker-simulate-gateway)).
- **Why Confidential HTTP?** The workflow needs to call your backend with an API key. Confidential HTTP lets the DON inject the key from the vault so it never appears in workflow code or logs. We use it for: **createMarketsFromBackend** (GET agent-markets, POST onchain-created) and **runSettlement** (POST settlement/run, POST settlement/resolved). Use it whenever the workflow must call an authenticated API and you want the secret to stay in the vault only. See [Chainlink CRE Confidential HTTP](https://docs.chain.link/cre) and the SDK `ConfidentialHTTPClient`.

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

### Sub0 CRE forwarder (required for create market)

CRE does not call your Sub0 contract directly. It sends the report to a **Chainlink Keystone Forwarder** contract; the Forwarder then calls `Sub0.onReport()`. So when your workflow runs with `--broadcast`, the transaction you see on the block explorer is **to the Forwarder**, not to Sub0. The Forwarder is the one that calls Sub0; therefore Sub0 must trust the **Forwarder contract address**.

1. **Get the Forwarder address:** Open the successful writeReport transaction on the block explorer (e.g. [sepolia.basescan.org](https://sepolia.basescan.org)). The **"To"** address of that transaction is the Keystone Forwarder contract. Use that address.
2. **On Sub0 (owner):** Call `setCreForwarderAddress(forwarderAddress)` with that Forwarder contract address.
3. **Grant role:** Grant `GAME_CREATOR_ROLE` to that same Forwarder address on the permission manager so the Forwarder can create Public markets when it calls `onReport`.

Without this, when the Forwarder calls `Sub0.onReport()`, Sub0 reverts with `CREForwarderNotSet()` or `CREInvalidSender`, so the market is never created even though the Forwarder received the report and the outer transaction succeeded.

**Use the Sub0 proxy address in CRE config:** After deploying with `just deploy`, the log shows "Sub0 (proxy): 0x..." and "Sub0 (implementation): 0x...". In `markets/config.staging.json` and `config.production.json` (and contracts.json if used), set `contracts.sub0` to the **proxy** address, not the implementation. The Forwarder must call the proxy so that `onReport` runs in proxy context (with storage where the forwarder address and owner are set); calling the implementation directly reverts (ReportProcessed result = false).

**Run set-cre-forwarder after every deploy:** A new deploy does not set the CRE forwarder on the new proxy. If you skip this step, `onReport` reverts with CREForwarderNotSet and ReportProcessed shows result = false. From `sub0contract`: ensure `SUB0_ADDRESS` in `.env` is the proxy from the deploy log, then run `just set-cre-forwarder`.

**Script to set forwarder and grant role:** From the `sub0contract` directory, run the Foundry script (requires `PRIVATE_KEY` = Sub0 owner and `SUB0_ADDRESS`; optional `CRE_FORWARDER_ADDRESS`; defaults to Base Sepolia forwarder if omitted):

```bash
cd sub0contract
export PRIVATE_KEY=0x...   # Sub0 owner key
export SUB0_ADDRESS=0x3b3be6228e251675Bd75b929C4256D940e11C5dC
# Optional: export CRE_FORWARDER_ADDRESS=0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5
forge script script/setCreForwarder.s.sol:SetCreForwarder -vvvv --rpc-url <RPC_URL> --broadcast
```

Or use `just set-cre-forwarder` if your justfile defines it (see `sub0contract/justfile`). The forwarder address is **public per chain** (Chainlink docs or the "To" of any successful writeReport tx); you do not need to run a workflow simulation to discover it.

**Reading transmission info (workflowExecutionId, reportId):** The CRE SDK `writeReport` reply does not return `workflowExecutionId` or `reportId`. Those are used on-chain by the Forwarder. To call the Forwarder's `getTransmissionInfo(receiver, workflowExecutionId, reportId)` or `getTransmitter(...)` you must obtain the ids from the **ReportProcessed** event: use the `txHash` returned by the workflow, fetch the transaction receipt, decode the Forwarder's `ReportProcessed(receiver, workflowExecutionId, reportId, result)` log, then call the Forwarder view with that `receiver` (your Sub0 address), `workflowExecutionId`, and `reportId`. The Forwarder ABI is in `markets/lib/abi/forwarder.json` and exported as `FORWARDER_ABI` from `lib/abis.ts`.

### Optional

| Variable           | Purpose                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `HTTP_API_KEY`     | If set in secrets (e.g. namespace `sub0`), HTTP trigger requires `body.apiKey` to match.  |
| `BACKEND_API_KEY`  | For `createMarketsFromBackend` and settlement: **must equal the backend's `API_KEY`** (the value the backend expects in `x-api-key` for `/api/internal/*`). In simulate/Docker, set in `.env`; with `docker-settings` the workflow uses this via getSecret (plain auth). In production, store in CRE vault (namespace `sub0`, id `BACKEND_API_KEY`). |

**PLATFORM_ORACLE_ADDRESS / PLATFORM_CREATOR_ADDRESS / DEFAULT_COLLATERAL_TOKEN:** These are used by the **backend** when it generates agent market payloads (Gemini + Grok). The backend sends full payloads to CRE (including oracle and creator), so CRE does not need these in secrets for createMarketsFromBackend. Optionally they can be moved to CRE secrets or confidential compute later so the backend only sends question/duration/agentSource and CRE injects oracle/creator.

### Declarations

`secrets.yaml` declares logical names (e.g. `BACKEND_SIGNER_PRIVATE_KEY`, `HTTP_API_KEY`). For local simulation, set values in `.env`. For deployed workflows, use `cre secrets create` and reference the same names.

---

## References

- [CRE Documentation](https://docs.chain.link/cre)
- [Simulating Workflows](https://docs.chain.link/cre/guides/operations/simulating-workflows)
- Project docs in `md/` (e.g. `md/confidential-workflows.cre.md`, `md/workflows.http.md`)
