[seed-market-liquidity] Failed {
  questionId: '0xb2510c0df0136c96e7e2f976771844518cee627701cf4f27bf0f10d3e79237bc',
  error: 'Missing or invalid parameters.\n' +
    'Double check you have provided the correct parameters.\n' +
    '\n' +
    'URL: https://sepolia.drpc.org\n' +
    'Request body: {"method":"eth_sendRawTransaction","params":["0x02f8b383aa36a7821c68830f4240830f424a8302a12a94fc4def105b3288e41f0ae8818bdd48d58f95077280b844765ee7ddb2510c0df0136c96e7e2f976771844518cee627701cf4f27bf0f10d3e79237bc00000000000000000000000000000000000000000000000000000002540be400c080a032bf97b7d43933aa21f8206872cc9f9078c373386695b9104d5cd8f15213fecaa07eae5077fd2fe66bf9617cb64a28134c9efb28e0c7c0decdec120e5a10c87a3c"]}\n' +
    ' \n' +
    'Request Arguments:\n' +
    '  chain:  Sepolia (id: 11155111)\n' +
    '  from:   0xf0830060f836B8d54bF02049E5905F619487989e\n' +
    '  to:     0xFC4DEF105b3288E41f0aE8818bDD48d58F950772\n' +
    '  data:   0x765ee7ddb2510c0df0136c96e7e2f976771844518cee627701cf4f27bf0f10d3e79237bc00000000000000000000000000000000000000000000000000000002540be400\n' +
    ' \n' +
    'Contract Call:\n' +
    '  address:   0xFC4DEF105b3288E41f0aE8818bDD48d58F950772\n' +
    '  function:  seedMarketLiquidity(bytes32 questionId, uint256 amountUsdc)\n' +
    '  args:                         (0xb2510c0df0136c96e7e2f976771844518cee627701cf4f27bf0f10d3e79237bc, 10000000000)\n' +
    '  sender:    0xf0830060f836B8d54bF02049E5905F619487989e\n' +
    '\n' +
    'Docs: https://viem.sh/docs/contract/writeContract\n' +
    'Details: replacement transaction underpriced\n' +
    'Version: viem@2.46.3'
}


WHATS THE CAUSE OF FAIL


The key part of your error is:

> **`Details: replacement transaction underpriced`**

This is **not** a contract error and not a bad parameter issue. It’s a **mempool / gas pricing issue** on Sepolia.

---

## ✅ What “replacement transaction underpriced” Means

You are trying to send a transaction that:

* Has the **same nonce**
* From the **same address**
* While a previous transaction with that nonce is **still pending**
* But the new transaction does **not increase the gas price enough**

Ethereum nodes reject it because:

> Replacement transactions must increase gas fees by a minimum percentage (usually ~10–12%).

---

## 🔎 Why It Happened In Your Case

From your logs:

* Chain: **Sepolia (11155111)**
* From: `0xf0830060f836B8d54bF02049E5905F619487989e`
* Method: `eth_sendRawTransaction`
* Function: `seedMarketLiquidity(bytes32,uint256)`
* Viem version: `2.46.3`

This means you likely:

1. Sent a `seedMarketLiquidity` tx
2. It is still **pending**
3. You tried to send another tx with:

   * Same nonce
   * Same or lower gas fees
4. RPC rejected it

---

## 🔥 Common Causes

### 1️⃣ You manually set gas fees

If you're setting:

```ts
maxFeePerGas
maxPriorityFeePerGas
```

And reused the same values → underpriced.

---

### 2️⃣ You're retrying too fast

If your script retries automatically before the previous tx confirms.

---

### 3️⃣ You're manually setting nonce

If you're doing:

```ts
nonce: await publicClient.getTransactionCount(...)
```

And not incrementing it properly.

---

### 4️⃣ Sepolia RPC congestion

Sepolia sometimes behaves weirdly with replacement rules.

---

## 🛠 How To Fix It

### ✅ Option 1 — Let viem handle everything (Recommended)

Remove manual:

* `gas`
* `nonce`
* `maxFeePerGas`
* `maxPriorityFeePerGas`

Just do:

```ts
await walletClient.writeContract({
  address,
  abi,
  functionName: 'seedMarketLiquidity',
  args: [questionId, amount],
})
```

---

### ✅ Option 2 — Increase gas by 15%+

If replacing a tx, bump fees:

```ts
maxFeePerGas: previousMaxFee * 1.15n,
maxPriorityFeePerGas: previousPriority * 1.15n,
```

Minimum safe bump: **+12–15%**

---

### ✅ Option 3 — Wait for previous tx to confirm

```ts
await publicClient.waitForTransactionReceipt({ hash })
```

Before sending another transaction.

---

### ✅ Option 4 — Manually increment nonce

If you really must control nonce:

```ts
const nonce = await publicClient.getTransactionCount({
  address,
  blockTag: 'pending'
})
```

Use `blockTag: 'pending'` not `latest`.

---

## 🚫 This Is NOT The Problem

It is NOT:

* Wrong `questionId`
* Wrong `amount`
* Contract revert
* Bad ABI encoding
* USDC amount too large
* Function signature issue

The calldata is valid.

---

## 🎯 Final Answer

The failure is caused by:

> You attempted to replace a pending transaction without increasing gas fees enough, so the RPC rejected it as **"replacement transaction underpriced"**.

---

If you paste your `writeContract` code, I can pinpoint exactly which setting is triggering it.



