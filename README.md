Pump.fun Relative-Strength Bot (hands-ts live, optional Python model)

Overview

- TypeScript hands service streams mainnet, computes CAER locally by default, and can route/execute trades on PumpSwap/Raydium.
- Optional Python model (FastAPI) can serve /tick and /decide; hands can call it if you set MODEL_MODE=remote.

Repo layout

- pumpbot/ (Python, paper mode + FastAPI model)
- hands-ts/ (TypeScript, streams + routing + execution)

Quick start (hands-ts only, local CAER)

1) Configure hands-ts/.env

```ini
# RPC
SOL_RPC_URL=https://your-primary-rpc
SOL_WS_URL=wss://your-primary-ws
SOL_RPC_URL_FAILOVER=https://your-failover-rpc
SOL_WS_URL_FAILOVER=wss://your-failover-ws

# Execution (provide one)
KEYPAIR_B58=base58_64byte_secret_key
# or: KEYPAIR=[12,34,...,64_numbers]
PRIORITY_FEE_LAMPORTS=0

# Decisions (local CAER)
MODEL_MODE=local             # remote to call Python API
ENTRY_USD=20                 # per buy; each tx sends ENTRY_USD / SPLITS_K
Z_ENTRY=1.0
Z_EXIT=0.5
SCHEDULER_SECONDS=5000       # ms
ACTIVE_MINT_AGE_S=900        # seconds

# Routing / risk (defaults shown)
SLIPPAGE_BPS=50
SWITCH_MARGIN_BPS=40
IMPACT_CAP_BPS=120
SPLITS_K=2
SLICE_DELAY_MS=250
PREFER_WSOL=true             # uses SOL_USD_HINT for sizing if true
SOL_USD_HINT=150
DENY_MINTS=
ALLOW_MINTS=
DAILY_LOSS_LIMIT_USD=0
KILL_SWITCH=false

# Safety
BLOCK_FREEZE=true            # block tokens with freeze authority
BLOCK_MINT_AUTH=true         # block tokens with active mint authority
DISABLE_CURVE_BUY=false      # true to trade AMM only

# IDLs (optional overrides)
PUMPFUN_IDL_PATH=C:\pump_system\hands-ts\pump.json
PUMPFUN_IDL_URL=https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json
PUMPSWAP_IDL_URL=https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pumpswap.json

# Pump.fun fee/creator vault
# Optional: explicit fee recipient (normally auto-detected from Global)
PUMPFUN_FEE_RECIPIENT=
# Persistent creator_vault cache file (auto-managed)
CREATOR_VAULT_STORE_PATH=C:\pump_system\hands-ts\creator_vault_cache.json
# TTLs
PUMPFUN_FEE_REFRESH_MS=300000
PUMPFUN_CREATOR_VAULT_REFRESH_MS=300000

# Universe/backfill and activity gates
# Backfill recent Pump.fun signatures at startup to expand mint universe
BACKFILL_ON_START=true
BACKFILL_SIG_LIMIT=300
# Filter out mints with no trade within the last N seconds
STALE_MINT_MAX_S=300
```

2) Start hands

```bash
cd hands-ts
npm install
npm run dev
```

Optional: Python model (remote decisions)

```bash
python -m pumpbot serve --config config.yaml --host 127.0.0.1 --port 8080
# then set MODEL_MODE=remote and MODEL_BASE_URL=http://127.0.0.1:8080 in hands-ts/.env
```

What it does (high-level)

- Streams Pump.fun, PumpSwap, and Raydium v4; RPC failover with backoff.
- Parses tx meta into TradeTicks; updates rolling windows [60,300,900]s.
- Computes CAER + robust z in-process (or calls Python /decide if remote).
- Venue logic: quote PumpSwap and Raydium, switch if better by SWITCH_MARGIN_BPS, enforce IMPACT_CAP_BPS, freshness, and retries; split into K slices, wrap/unwrap WSOL.
- Safety: blocks freeze/mint authorities, non-standard token program (Token-2022 fees/hooks), deny/allow lists, daily loss limit, kill switch.
- Phase: auto-detects AMM by probing PumpSwap pools; also listens for migration.
- Universe: on startup, backfills recent Pump.fun transactions to seed `seenMints`; every tick filters to Pump.fun-created tokens (checks `bonding-curve` PDA exists), and drops mints with no trade in `STALE_MINT_MAX_S`.

Key notes

- Active universe: a mint is active if seen within ACTIVE_MINT_AGE_S, has ≥1 trade in 300s, has traded within `STALE_MINT_MAX_S` (default 300s), and is Pump.fun-created (bonding-curve PDA exists). Decisions run when ≥3 mints are active.
- If KEYPAIR is not set, hands computes decisions and logs but does not send txs.
- Curve buys can be disabled via DISABLE_CURVE_BUY=true to avoid bonding-curve path.
- Pump.fun IDL can be pinned via PUMPFUN_IDL_PATH/PUMPFUN_IDL_URL.

Expected logs

- [startup] hands-ts starting | streams starting/started
- [streams] no trades … waiting… (quiet periods)
- [scheduler] waiting: active mints < 3 or insufficient trades
- [decision] buy/exit … z=… phase=…
- [execute][pumpswap|raydium|curve] … sigs=…

Signer formats

- KEYPAIR_B58: base58-encoded 64-byte Ed25519 secret key (full secretKey).
- KEYPAIR: JSON array of 64 numbers (Solana id.json style).

Venue rules (summary)

- Prefer PumpSwap; fallback to Raydium if:
  - Raydium quote better by ≥ SWITCH_MARGIN_BPS, or
  - PumpSwap impact > IMPACT_CAP_BPS and Raydium ≤ cap, or
  - PumpSwap health/freshness checks fail while Raydium passes.
- Keep venue fixed within a K-slice batch; re-evaluate next batch.

Troubleshooting

- Invalid KEYPAIR JSON / “Unexpected non-whitespace …”: remove KEYPAIR or fix JSON; prefer KEYPAIR_B58.
- Anchor IDL errors (e.g., Option types): hands now prefers your local pump.json; ensure PUMPFUN_IDL_PATH points to it.
- Unable to resolve account fee_recipient: ensure pump.json is present/up-to-date; hands reads Global and extracts fee_recipient/fee_recipients. You can set PUMPFUN_FEE_RECIPIENT as a temporary override.
- Unable to resolve creator_vault: bot will cache per-mint from BondingCurve.creator and persist to creator_vault_cache.json; if a mint isn’t Pump.fun or curve isn’t initialized, bot falls back to AMM automatically.
- Associated address seed errors on curve: bot creates missing `associated_bonding_curve` ATA and ensures `associated_user` uses the payer’s ATA.
- Small/unsteady universe: enable BACKFILL_ON_START and raise BACKFILL_SIG_LIMIT; ensure RPC/WS are healthy.
- No activity: check RPC/WS, ensure ≥3 active mints (adjust ACTIVE_MINT_AGE_S), or lower Z_ENTRY.

Python paper mode

```bash
python -m pumpbot run --mode paper --config config.yaml
```

Config (Python)

- See config.yaml for thresholds, risk, smoothing, exit rules. Paper mode is independent from hands and useful for offline testing.

Disclaimer

- Safety checks reduce, but do not eliminate, risk (honeypots, traps, MEV). Start with tiny sizes and conservative caps.
