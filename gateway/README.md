# CRE Simulate Gateway (Docker)

HTTP server that runs `cre workflow simulate markets` per request. Used by the Docker image and optionally by the backend.

## Build and run

From `sub0cre` (so `$(pwd)` is the project dir):

```bash
cd sub0cre
docker build -t sub0cre-gateway .
docker run --rm --name sub0cre-gateway -p 8080:8080 \
  --add-host=host.docker.internal:host-gateway \
  -e CRE_TARGET=docker-settings \
  -e CRE_USE_VOLUME_AUTH=true \
  -e INFISICAL_TOKEN="your-token" \
  -v "$(pwd)/markets/config.docker.json:/config/cre.json" \
  -e CRE_CONFIG_FILE=/config/cre.json \
  -v "$HOME/.cre:/root/.cre" \
  sub0cre-gateway
```


### Adding -e CRE_CRON_SCHEDULE="*/10 * * * *" (or any 5-field cron) overrides that and uses the env schedule instead; the rest of the command is unchanged.
```bash
cd sub0cre
docker build -t sub0cre-gateway .
docker run --rm --name sub0cre-gateway -p 8080:8080 \
  --add-host=host.docker.internal:host-gateway \
  -e CRE_TARGET=docker-settings \
  -e CRE_USE_VOLUME_AUTH=true \
  -e INFISICAL_TOKEN="your-token" \
  -e CRE_CRON_SCHEDULE="*/10 * * * *" \
  -v "$(pwd)/markets/config.docker.json:/config/cre.json" \
  -e CRE_CONFIG_FILE=/config/cre.json \
  -v "$HOME/.cre:/root/.cre" \
  sub0cre-gateway
```

This is the main command: Infisical for secrets, config from `$(pwd)/markets/config.docker.json`, and target `docker-settings`. Cron uses the **config JSON’s `schedule`** (6→5) by default. **To use an env-based schedule instead of the config’s**, add `-e CRE_CRON_SCHEDULE="*/10 * * * *"` (or any 5-field cron); that overrides the config schedule and the rest of the command stays the same.

**Without Infisical (env from file):** Use the same run but drop `INFISICAL_TOKEN` and `CRE_USE_VOLUME_AUTH`, and add `--env-file .env`. Ensure `sub0cre/.env` has `CRE_ETH_PRIVATE_KEY`, `BACKEND_SIGNER_PRIVATE_KEY`, `BACKEND_API_KEY`, and optionally `HTTP_API_KEY`, `CRE_TARGET=docker-settings`. On Linux keep `--add-host=host.docker.internal:host-gateway`.

## Environment variables (Docker)

| Variable | Where it goes | Description |
|----------|----------------|-------------|
| **CRE_CONFIG_FILE** | Container path to a JSON file. Set with `-e CRE_CONFIG_FILE=/config/cre.json`. | Path **inside the container** to your workflow config JSON. At startup the entrypoint **copies** this file to `markets/config.docker.json`, so the workflow uses it (backendUrl, contracts, schedule, etc.). Example: mount a file and point to it: `-v /host/my-config.json:/config/cre.json -e CRE_CONFIG_FILE=/config/cre.json`. If unset, the image uses the built-in `markets/config.docker.json`. |
| **CRE_CRON_SCHEDULE** | 5-field cron, e.g. `-e CRE_CRON_SCHEDULE="*/10 * * * *"`. | Optional. When set, used as the crontab (explicit override). When **unset**, the entrypoint reads `schedule` from `markets/config.docker.json`, converts 6-field → 5-field, and uses that. So you can rely on the config’s schedule alone. |

## Config file vs schedule (and 6→5 conversion)

- **Config `schedule`** is **6-field** (CRE style): `second minute hour day month day-of-week`, e.g. `"*/30 * * * * *"` = every 30 seconds. Used when the workflow is **deployed on CRE** (platform fires the Cron trigger at that interval).

- **CRE_CRON_SCHEDULE** is **5-field** (host cron): `minute hour day month day-of-week`, e.g. `*/10 * * * *` = every 10 minutes. So they are **different formats**; the config can express second granularity, host cron cannot.

- **In Docker**, the entrypoint now **unifies** them: if **CRE_CRON_SCHEDULE** is set, it is used as-is (explicit override). Otherwise the entrypoint reads `markets/config.docker.json`, takes `.schedule`, and **converts 6-field → 5-field** by dropping the first (seconds) field, then installs that as the crontab. So e.g. config `"*/30 * * * * *"` becomes crontab `* * * * *` (every minute; second granularity is lost). Result: one source of truth (the config file) when you don’t set CRE_CRON_SCHEDULE.

**Execution / functionality:** Both sources lead to the **same behaviour**: the same crontab runs `cron-trigger.sh` at the chosen times, which POSTs `createMarketsFromBackend` to the gateway. So whether you set CRE_CRON_SCHEDULE or rely on the config’s schedule (after 6→5), cron functionality is the same; only the **source** of the schedule (env vs config) and, when using config, the possible loss of second-level granularity differ. You can use either and cron still holds.

## Docker as a variant of deployed workflow

Yes. The Docker container is a **local, simulate variant** of a deployed workflow: same workflow code and config shape, but instead of the CRE platform hosting it and firing triggers, (1) the container runs one trigger per HTTP request (or per cron tick from CRE_CRON_SCHEDULE), and (2) there is no workflow ID or Chainlink gateway URL. So you can treat Docker as “deployed-like” for behaviour, while scheduling is controlled by CRE_CRON_SCHEDULE rather than the config’s `schedule` field.

## Config schedule 6→5 (implemented)

The entrypoint **uses the config’s schedule** when CRE_CRON_SCHEDULE is unset: it reads `markets/config.docker.json` (after copying CRE_CONFIG_FILE if set), parses `.schedule`, and converts 6-field → 5-field by dropping the first (seconds) field, then installs that as the crontab. So config `"*/30 * * * * *"` (every 30 sec) becomes `* * * * *` (every minute). **CRE_CRON_SCHEDULE** still overrides when set. One source of truth (config) is the default; explicit env wins.

## Where each env variable lives

| Variable | Env / place | Used by |
|----------|-------------|---------|
| **CRE_CRON_SCHEDULE** | sub0cre (Docker/gateway) | `gateway/entrypoint.sh`: installs crontab in container to POST createMarketsFromBackend. Set in sub0cre `.env` or `-e` when running the image. |
| **CRE_CONFIG_FILE** | sub0cre (Docker/gateway) | `gateway/entrypoint.sh`: path inside container to JSON copied to `markets/config.docker.json`. Set in sub0cre `.env` or `-e` when running the image. |
| **CONTRACT_PRIVATE_KEY** | sub0server `.env` | Backend config: signing key for `predictionVault.seedMarketLiquidity` and agent ETH funding. Required for seeding and onboarding. |
| **SEPOLIA_RPC_URL** (or **CHAIN_RPC_URL**) | sub0server `.env` | Backend config: RPC for Sepolia. Used for chain reads (e.g. getMarket, getOutcomePositionIds) and for sending the seed tx and other txs. |

So: **sub0cre** (gateway/Docker) = CRE_CRON_SCHEDULE, CRE_CONFIG_FILE. **sub0server** (backend) = CONTRACT_PRIVATE_KEY, SEPOLIA_RPC_URL.

## Seeding and liquidity (backend, uses SEPOLIA_RPC_URL)

Seeding runs on the **backend** (sub0server), not in the CRE container. When a market is created on chain (CRE or relayer), the backend either (1) gets an onchain-created callback (POST from CRE) or (2) finds the market via the pending poll. It then calls `seedMarketLiquidityOnChain(questionId, amountUsdc)`, which uses **SEPOLIA_RPC_URL** (or CHAIN_RPC_URL) and **CONTRACT_PRIVATE_KEY** to send a tx to `PredictionVault.seedMarketLiquidity(questionId, amountUsdc)`. After the tx succeeds, the backend updates the market row with `volume` and `liquidity` (from `PLATFORM_INITIAL_LIQUIDITY_RAW` or `PLATFORM_INITIAL_LIQUIDITY_PER_OUTCOME`). So the RPC URL is used both to read the chain (getMarket, outcome position IDs) and to submit and wait for the seed tx. If either the RPC or the private key is missing or wrong, seeding returns false and the DB stays at zero liquidity.
