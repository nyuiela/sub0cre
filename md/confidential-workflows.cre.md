# Configuring CRE CLI for Confidential Workflows

This note describes how to deploy and run the Privacy Track workflows (`createAgentKey`, `executeConfidentialTrade`) so they execute as **Confidential** workflows (inside the CRE enclave) rather than as standard workflows.

## 1. Separate workflow entrypoints

Each Confidential workflow is a **separate deployable** with its own entrypoint and (optionally) its own `workflow.yaml` target:

- **createAgentKey**: entrypoint `createAgentKey.ts`, HTTP trigger, returns `{ address }`.
- **executeConfidentialTrade**: entrypoint `executeConfidentialTrade.ts`, HTTP trigger, receives encrypted payload, signs and submits `executeTrade`, returns `{ txHash }`.

Do not bundle them in the same `main.ts` as the existing cron/quote workflows. Deploy each as its own workflow folder so the CRE runtime can run it in Confidential Compute mode when so configured.

## 2. Folder layout per workflow

Use one folder per workflow so the CLI can target it independently:

```
markets/
  createAgentKey.ts
  config.createAgentKey.staging.json   # optional: minimal config
  workflow.createAgentKey.yaml         # optional: see below

  executeConfidentialTrade.ts
  config.staging.json                  # re-use or copy; must include contracts
  workflow.confidential-trade.yaml     # optional
```

Or keep both in `markets/` and use **different workflow-path** in `workflow.yaml` per target.

## 3. workflow.yaml targets for Confidential vs standard

In your **workflow settings file** (e.g. `workflow.yaml`), define one target per workflow and point `workflow-path` to the correct entrypoint:

```yaml
# Standard main workflow (existing)
staging-settings:
  user-workflow:
    workflow-name: "cal-workflow-staging"
  workflow-artifacts:
    workflow-path: "./main.ts"
    config-path: "./config.staging.json"
    secrets-path: ""

# Confidential: create agent key
create-agent-key-staging:
  user-workflow:
    workflow-name: "create-agent-key-staging"
  workflow-artifacts:
    workflow-path: "./createAgentKey.ts"
    config-path: "./config.staging.json"
    secrets-path: ""

# Confidential: execute trade
execute-confidential-trade-staging:
  user-workflow:
    workflow-name: "execute-confidential-trade-staging"
  workflow-artifacts:
    workflow-path: "./executeConfidentialTrade.ts"
    config-path: "./config.staging.json"
    secrets-path: ""
```

Deploy each with the matching target:

```bash
cre workflow deploy . --target create-agent-key-staging
cre workflow deploy . --target execute-confidential-trade-staging
```

## 4. Deploying as Confidential (TEE) rather than standard

The CRE CLI and Workflow Registry support **Confidential Compute** so that the compiled WASM runs inside a secure enclave (TEE). Whether a workflow runs in the enclave is determined at **deployment/registration** time, not only by the code.

- **Project / account**: Ensure your CRE project and target environment are enabled for Confidential workflows (Early Access / Privacy Track).
- **Deploy**: Use the same `cre workflow deploy` command; the CLI or backend may accept a flag or project setting to register the workflow as **confidential** (e.g. so the registry stores a confidential flag or zone). Check the latest CRE CLI reference for a flag such as `--confidential` or a field in `project.yaml` / workflow target (e.g. `confidential: true` under `user-workflow`).
- **Trigger**: For `executeConfidentialTrade`, the HTTP trigger can receive an **encrypted payload** that is decrypted inside the enclave. End-to-end encryption and key handling are documented in the CRE guides for [Confidential API Interactions](https://docs.chain.link/cre/guides/workflow/using-confidential-http-client) and the [Confidential HTTP capability](https://docs.chain.link/cre/capabilities/confidential-http).

If the CLI does not yet expose a `--confidential` flag, the same workflow code will still run; to have it executed in a TEE, follow the current Chainlink CRE docs for “Confidential Compute” or “Privacy Track” and any registration/zone options in the Workflow Registry or project settings.

## 5. Secrets for agent keys

- **createAgentKey**: Returns only the wallet **address**. The private key is generated inside the enclave and must be persisted to CRE Secrets (Vault DON) under namespace `agent-keys` with id = `agentId`. The CRE SDK does not expose a `storeSecret` API; secrets are provisioned via `cre secrets create` (see [Using Secrets with Deployed Workflows](https://docs.chain.link/cre/guides/workflow/secrets/using-secrets-deployed)). For a full zero-exposure flow, the key would need to be written from the enclave via a future capability or a secure handshake with the Vault DON.
- **executeConfidentialTrade**: Reads the agent private key with `runtime.getSecret({ id: agentId, namespace: "agent-keys" })`. Before calling this workflow, ensure the key for each `agentId` exists in that namespace (e.g. via `cre secrets create` with a YAML that maps the secret id to the agent key value).

## 6. Simulate before deploy

Run each workflow locally with the same config and payload shape:

```bash
# Create agent key (HTTP payload with agentId)
cre workflow simulate . --target staging-settings --trigger-index 0 --http-payload '{"agentId":"my-agent-1"}' --config config.staging.json createAgentKey.ts

# Execute confidential trade (HTTP payload with trade params)
cre workflow simulate . --target staging-settings --trigger-index 0 --http-payload '{"agentId":"my-agent-1","marketId":"0x...","outcomeIndex":0,"buy":true,"quantity":"1000000","tradeCostUsdc":"500000","nonce":"0","deadline":"9999999999"}' --config config.staging.json executeConfidentialTrade.ts
```

Adjust `--config` and `--target` to match your workflow folder and environment.
