# Universal CRE Docker Platform: Hosting Workflows for Developers

This document describes how to structure a **universal Docker-based platform** so that (1) CRE workflows can be run without Chainlink hosting, (2) the gateway is exposed as a backend endpoint that developers can call, and (3) developers can structure their CRE workflows to work both on **Chainlink** (native deployment) and inside **this Docker platform** without conflict.

---

## 1. Current Setup (What You Have Today)

- **CRE does not provide hosting.** Workflows run either on Chainlink (when deployed) or locally via `cre workflow simulate`.
- **Your Docker image (sub0cre):**
  - Runs a **gateway** HTTP server (e.g. `gateway/server.ts`) on a fixed port (e.g. 8080).
  - Receives POST requests with a JSON body (e.g. `{ action: "createMarketsFromBackend", apiKey?, broadcast? }`).
  - Writes the body to a temp file and runs:  
    `cre workflow simulate markets --non-interactive --trigger-index 1 --http-payload @file --target <CRE_TARGET> [--broadcast]`
  - Returns the workflow result (stdout/JSON) as the HTTP response.
- **Backend (sub0server):** Sets `CRE_HTTP_URL` to the gateway URL (e.g. `http://cre-gateway:8080`). It triggers workflows by POSTing to that URL. Callbacks from the workflow (e.g. onchain-created, agent-keys) go to the backend at `config.backendUrl` (e.g. `/api/cre/markets/onchain-created`).

So the **blocker** is hosting: the gateway must be run somewhere and its URL exposed. The Docker container does that by running the gateway and exposing the port.

---

## 2. Goal: Platform for Other Developers

- **Platform:** You run infrastructure that spawns **Docker containers**. Each container runs a CRE gateway + a **developer’s** workflow (not only sub0cre).
- **Flow:**  
  (1) Developer provides their CRE workflow (or you add it to the container).  
  (2) Container starts with that workflow, gateway listens on a port.  
  (3) Platform exposes that port (e.g. load balancer, ingress, or direct host port).  
  (4) Platform returns the **gateway base URL** to the developer.  
  (5) Developer (or their backend) triggers workflows by POSTing to that URL, same contract as today (e.g. `action`, `apiKey`, `broadcast`).

So the Docker container must be **universal**: it must be able to run **any** CRE workflow and expose a single, consistent HTTP API that the platform (and the developer’s app) can use.

---

## 3. What the Universal Docker Container Must Do

The container is the **host** for the CRE workflow and the **gateway** that turns HTTP into `cre workflow simulate`:

1. **Expose one HTTP endpoint** (e.g. `POST /` or `POST /trigger`) that:
   - Accepts JSON body (any shape; typically at least `action` for routing).
   - Writes body to a temp file.
   - Runs:  
     `cre workflow simulate <WORKFLOW_DIR> --non-interactive --trigger-index <HTTP_TRIGGER_INDEX> --http-payload @file [--broadcast] [--target <TARGET>]`
   - Returns the workflow result (parsed JSON or raw) as the response.

2. **Parameterize** (via env or mount):
   - **Workflow directory** (e.g. `WORKFLOW_DIR=markets` or a mounted path).
   - **HTTP trigger index** (e.g. `CRE_TRIGGER_INDEX=1` if the HTTP trigger is the second trigger in the workflow).
   - **CRE target** (e.g. `CRE_TARGET=docker-settings`).
   - **Config path** (e.g. `CRE_CONFIG_FILE=/config/cre.json`) so the workflow can use platform-provided config (e.g. `backendUrl`, chain IDs).

3. **Credentials:** Either bake CRE credentials into the image (e.g. `cre.zip` → `~/.cre`) or mount them at runtime (`CRE_CREDENTIALS_PATH`) so `cre workflow simulate` can authenticate.

4. **Secrets for the workflow:** Injected via env (e.g. Infisical or env file) so the workflow has `BACKEND_API_KEY`, `HTTP_API_KEY`, `CRE_ETH_PRIVATE_KEY`, etc. The entrypoint can write these to `.env` in the workflow cwd so the CRE CLI sees them.

5. **Expose port** (e.g. 8080). The platform maps this to a public or internal URL and returns that URL to the developer.

So: **one container = one workflow + one gateway**. To support many developers, the platform **spawns one container per tenant/workflow** (or per deployment), injects their workflow assets and config, and returns the gateway URL.

---

## 4. How Developers Should Structure Their CRE Workflow

So that the same workflow runs on **Chainlink** (native) and inside **your Docker platform** without conflict:

### 4.1. HTTP trigger contract

- **One HTTP trigger** in the workflow that receives the **entire** JSON body (e.g. from `payload.input`).
- **Convention:** Body should include at least:
  - `action` (string): so the gateway/platform and the workflow can route to the right handler (e.g. `createMarketsFromBackend`, `createAgentKey`, `quote`, `order`).
  - `apiKey` (optional): if the workflow validates HTTP API key (e.g. from secrets), the platform or developer backend can send it.
  - `broadcast` (optional): whether to perform real onchain txs (gateway can pass this through or use a default).
- The workflow parses `body.action` and dispatches to the right handler. This is exactly what sub0cre does today; other workflows can do the same.

### 4.2. Trigger order (index)

- **Stable trigger order** in the workflow registration (e.g. `handler(cron.trigger(...), ...)`, then `handler(http.trigger(...), ...)`).
- **HTTP trigger index:** The platform (and your gateway) must use the **same** trigger index (e.g. `1` if HTTP is the second trigger). Document this for developers: e.g. “Use HTTP as trigger index 1 (0-based: cron=0, http=1).”
- When deployed on **Chainlink**, the same workflow runs with the same trigger order; Chainlink will fire the HTTP trigger when it receives an HTTP request. So no change needed for native deployment.

### 4.3. Config and secrets

- **Config:** Use a config file (e.g. JSON) that includes:
  - `backendUrl`: URL of the backend that receives callbacks (onchain-created, agent-keys, etc.). The **platform** sets this (e.g. via `CRE_CONFIG_FILE` or env `BACKEND_URL` written into config at container start) so the workflow knows where to POST results.
  - Chain IDs, contract addresses, schedule, etc., as needed.
- **Secrets:** Use env (or a secrets provider) for keys, API keys, private keys. The Docker entrypoint can inject these from the platform (e.g. Infisical, or env file) so the workflow has them at runtime. When on Chainlink, the same secret IDs can be resolved by Chainlink’s secret store.

This way: **same workflow code and same config shape**; only the **values** (e.g. `backendUrl`, secrets) differ between Docker and Chainlink.

### 4.4. Callbacks to the backend

- When the workflow must notify a backend (e.g. “market created”, “agent key created”), it should POST to `config.backendUrl + path` (e.g. `/api/cre/markets/onchain-created`).
- On your platform, `backendUrl` is set to the **developer’s backend** (or your platform’s callback aggregator). On Chainlink, it can be the same developer backend URL. So the workflow does not need to change; only config changes.

### 4.5. Summary for developers

- **One HTTP trigger** that reads a JSON body with `action` (and optional `apiKey`, `broadcast`).
- **Fixed trigger index** for HTTP (e.g. 1), and document it so the platform can pass `--trigger-index 1`.
- **Config-driven** `backendUrl` and chain/config; **secrets via env** (or same secret IDs as on Chainlink).
- **Same repo and workflow** deployable to Chainlink as-is; the only difference is who invokes the HTTP trigger (your gateway in Docker vs Chainlink’s HTTP trigger in production).

---

## 5. Platform Flow End-to-End

1. **Developer** (or your UI) provides: workflow source (e.g. git repo or tarball), optional config overlay, optional CRE target name.
2. **Platform** builds or selects a **universal image** that includes:
   - CRE CLI, gateway server (parameterized by env), and runtime (e.g. Bun/Node).
   - No workflow baked in; workflow dir is mounted or copied in at start.
3. **Platform** spawns a container with:
   - **Workflow dir** mounted or copied (e.g. `/app/workflow`).
   - **Env:** `WORKFLOW_DIR=/app/workflow`, `CRE_TRIGGER_INDEX=1`, `CRE_TARGET=docker-settings`, `CRE_CONFIG_FILE=/config/cre.json`, `BACKEND_URL=<developer or platform callback URL>`.
   - **Config file** at `/config/cre.json` (or path of choice) with `backendUrl` and any chain/config the workflow expects.
   - **Secrets** injected (env or Infisical token); entrypoint writes them to `.env` or the workflow reads from env.
   - **CRE credentials** (baked in image or mounted via `CRE_CREDENTIALS_PATH`).
   - **Port** 8080 exposed and mapped to a public or internal URL.
4. **Platform** returns **gateway base URL** (e.g. `https://tenant-xyz.platform.com` or `http://host:port`) to the developer.
5. **Developer** (or their backend) triggers workflows by:
   - `POST <gateway base URL>/` or `POST <gateway base URL>/trigger`
   - Body: `{ "action": "createMarketsFromBackend", "apiKey": "...", "broadcast": true }` (or whatever actions the workflow supports).
6. **Interacting with every workflow/playbook:** The gateway does **not** need to know the list of actions. It only forwards the JSON body to `cre workflow simulate`. The **workflow code** (e.g. `main.ts`) is what interprets `action` and runs the right handler. So as long as the developer’s workflow follows the same HTTP contract (body with `action` + optional fields), the platform can interact with every action/playbook they implement.

---

## 6. Chainlink Native Deployment: No Conflict

- **Same workflow structure:** One HTTP trigger, same trigger index, same body contract (`action`, etc.).
- **On Chainlink:** The workflow is deployed and Chainlink exposes an HTTP endpoint that fires the HTTP trigger with the request body. The workflow code is unchanged.
- **On your platform:** The gateway in the Docker container receives the POST, writes the body to a file, and runs `cre workflow simulate ... --trigger-index 1 --http-payload @file`. The workflow code is the same; only the **runner** is different (simulate in Docker vs Chainlink runtime).

So developers **do not** need two different CRE structures. They structure once (HTTP trigger, config-driven, secrets via env/Chainlink), and use the same repo for both:
- **Your platform:** Docker container with gateway + their workflow; they get a URL and POST to it.
- **Chainlink:** Deploy the same workflow; Chainlink hosts it and exposes the HTTP trigger. They (or their backend) can call that URL instead when they move to production.

---

## 7. Summary

| Topic | Summary |
|-------|--------|
| **Blocker** | CRE does not host; the Docker container runs the gateway and exposes the endpoint. |
| **Universal container** | Parameterized gateway: `WORKFLOW_DIR`, `CRE_TRIGGER_INDEX`, `CRE_TARGET`, config path; single POST endpoint that runs `cre workflow simulate` with the request body as `--http-payload`. |
| **Exposing the endpoint** | Container exposes one port (e.g. 8080); platform maps it to a URL and returns that URL to the developer. |
| **Developer workflow structure** | One HTTP trigger; body with `action` (and optional `apiKey`, `broadcast`); config-driven `backendUrl` and secrets via env; stable trigger index (e.g. 1). |
| **Interacting with every workflow** | Gateway forwards full JSON to the workflow; the workflow’s own code routes by `action` and runs the right playbook. No need for the gateway to enumerate actions. |
| **Chainlink compatibility** | Same workflow and contract work on Chainlink; only the execution environment and who invokes the HTTP trigger differ. |

No code edits are implied in this document; it is a design and structure guide for the universal Docker platform and for developer-facing CRE workflow conventions.
