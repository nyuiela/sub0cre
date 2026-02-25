# Set the default CRE target environment
TARGET := "staging-settings"

# Default command when typing just `just`
default:
    @just --list


# Install dependencies and setup the WASM toolchain
install:
    bun install --cwd ./markets

# Run the interactive workflow simulation
sim:
    cre workflow simulate markets --target {{TARGET}}

# Simulate Market Creation (append --broadcast to execute on-chain)
sim-create *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/create-market-payload.json --target {{TARGET}} {{args}}

# Simulate Get Market by questionId
sim-get-market *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/get-market-payload.json --target {{TARGET}} {{args}}

# Simulate Liquidity Seeding (append --broadcast to execute on-chain)
sim-seed *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/seed-payload.json --target {{TARGET}} {{args}}

# Simulate LMSR Pricing Engine
sim-lmsr *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/lmsr-pricing-payload.json --target {{TARGET}} {{args}}

# Simulate Confidential Compute Trade Execution
sim-confidential *args:
    cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @../payloads/execute-confidential-trade-payload.json --target {{TARGET}} {{args}}

# Deploy the workflow to the Chainlink registry
deploy:
    cre workflow deploy markets --target {{TARGET}}

# Activate the deployed workflow on the DON
activate:
    cre workflow activate markets --target {{TARGET}}

# Helper: Authenticate with the CRE CLI
login:
    cre login