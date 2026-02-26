# Set the default CRE target environment
TARGET := "staging-settings"

# Default command when typing just `just`
default:
    @just --list


# Install dependencies and setup the WASM toolchain (run from sub0cre; includes cre-setup in markets)
install:
    bun install --cwd ./markets

# Build workflow to WASM so CRE CLI can run simulate (avoids "no such file or directory" for .cre_build_tmp.wasm).
# Run from sub0cre. Tries cre-compile; if .cre_build_tmp.wasm is missing, copies main.wasm so simulate can run.
build-workflow:
    cd markets && bun x cre-compile main.ts .cre_build_tmp.wasm || true
    cd markets && test -f .cre_build_tmp.wasm || cp -f main.wasm .cre_build_tmp.wasm

# Run the interactive workflow simulation (build-workflow recommended first if simulate fails)
sim:
    cre workflow simulate markets --target {{TARGET}}

# Simulate Market Creation (dry run; response uses payload data when chain read is stale). Payload path relative to sub0cre.
sim-create *args:
    just build-workflow
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/create-market-payload.json --target {{TARGET}} {{args}}

# Create market and actually send txs to the deployed contract (requires CRE_ETH_PRIVATE_KEY and --broadcast).
sim-create-broadcast:
    just sim-create --broadcast

# Simulate Get Market by questionId
sim-get-market *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/get-market-payload.json --target {{TARGET}} {{args}}

# Simulate Resolve Market (Sub0 CRE 0x01; oracle must match market)
sim-resolve *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/resolve-market-payload.json --target {{TARGET}} {{args}}

# Simulate Stake (Sub0 CRE 0x02; forwarder stakes on behalf of owner)
sim-stake *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/stake-payload.json --target {{TARGET}} {{args}}

# Simulate Redeem (Sub0 CRE 0x03; owner must supply EIP-712 signature)
sim-redeem *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/redeem-payload.json --target {{TARGET}} {{args}}

# Simulate Liquidity Seeding (append --broadcast to execute on-chain)
sim-seed *args:
    just build-workflow
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/seed-payload.json --target {{TARGET}} {{args}}

# Simulate Quote signing (DON signs LMSR quote; use same questionId as created market)
sim-quote *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/quote-payload.json --target {{TARGET}} {{args}}

# Simulate Order (buy or sell; same handler as quote, returns signed quote)
sim-order *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/buy-payload.json --target {{TARGET}} {{args}}

# Simulate Buy order (order with buy: true)
sim-buy *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/buy-payload.json --target {{TARGET}} {{args}}

# Simulate Sell order (order with buy: false)
sim-sell *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/sell-payload.json --target {{TARGET}} {{args}}

# Simulate Create Agent Key (generates key in enclave, returns address)
sim-create-agent-key *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/create-agent-key-payload.json --target {{TARGET}} {{args}}

# Simulate LMSR Pricing Engine (DON computes cost and signs quote)
sim-lmsr *args:
    just build-workflow
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/lmsr-pricing-payload.json --target {{TARGET}} {{args}}

# Simulate Confidential Compute Trade Execution (standalone workflow)
sim-confidential *args:
    just build-workflow
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/execute-confidential-trade-payload.json --target {{TARGET}} {{args}}

# Run agent market creation: fetch from backend, create each on-chain, callback onchain-created (requires backend running and BACKEND_API_KEY in secrets).
sim-create-markets-from-backend *args:
    just build-workflow
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/create-markets-from-backend-payload.json --target {{TARGET}} {{args}}

# Simulate ERC20 approve (signer: backend or agent; returns signed tx for broadcast)
sim-approve-erc20 *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/approve-erc20-payload.json --target {{TARGET}} {{args}}

# Simulate ERC20 approve using agent key (set agentId in payload)
sim-approve-erc20-agent *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/approve-erc20-agent-payload.json --target {{TARGET}} {{args}}

# Simulate conditional token setApprovalForAll (signer: backend or agent; returns signed tx)
sim-approve-conditional-token *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/approve-conditional-token-payload.json --target {{TARGET}} {{args}}

# Simulate conditional token approve using agent key
sim-approve-conditional-token-agent *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/approve-conditional-token-agent-payload.json --target {{TARGET}} {{args}}

# Deploy the workflow to the Chainlink registry
deploy:
    cre workflow deploy markets --target {{TARGET}}

# Activate the deployed workflow on the DON
activate:
    cre workflow activate markets --target {{TARGET}}

# Helper: Authenticate with the CRE CLI
login:
    cre login