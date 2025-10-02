import 'dotenv/config';
import { loadConfig } from './config';
import { ModelClient } from './modelClient';
import { Streams } from './streams';
import { Executor } from './executor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { USDC_MINT, WSOL_MINT, PUMPFUN_PROGRAM_ID, PUMPSWAP_PROGRAM_ID, RAYDIUM_V4_PROGRAM_ID } from './constants';
import { PhaseRegistry } from './phaseRegistry';
import { RollingWindows } from './rolling';
import { AlphaEngine } from './alpha';
import { pumpSwapPoolHealthy } from './tx/pumpswap';
import { prefetchPumpfunFeeRecipient, prefetchPumpfunCreatorVault } from './tx/curve';
import { buildTradesFromSignature } from './txParse';
import { SolPriceOracle } from './priceOracle';

async function main() {
    const cfg = loadConfig();
    const modelMode = (process.env.MODEL_MODE || 'local').toLowerCase(); // 'local' or 'remote'
    const model = modelMode === 'remote' ? new ModelClient(cfg.modelBaseUrl) : undefined;
    const rpcPrimary = cfg.rpcHttpUrls[0] || 'https://api.mainnet-beta.solana.com';
    const seenMints = new Map<string, number>();
    const pumpMintCache = new Map<string, boolean>();

    console.log('[startup] hands-ts starting');
    console.log(`[startup] rpc=${rpcPrimary} modelMode=${modelMode} preferWsol=${process.env.PREFER_WSOL || 'true'} splitsK=${cfg.splitsK}`);

    // In-process CAER engine and rolling windows should be ready before streams callbacks
    const rolling = new RollingWindows([60, 300, 900]);
    const alpha = new AlphaEngine(rolling, [60, 300, 900]);

    const streams = new Streams({
        rpcUrl: rpcPrimary,
        programIds: [PUMPFUN_PROGRAM_ID, PUMPSWAP_PROGRAM_ID, RAYDIUM_V4_PROGRAM_ID]
    }, async (trades) => {
        // update rolling windows with each trade
        const now = Date.now() / 1000
        if (!trades.length) {
            console.log('[streams] no trades in this event; waiting...')
        }
        for (const t of trades) {
            rolling.update(t)
            seenMints.set(t.token_mint, now)
        }
        if (model) {
            try { await model.tick(trades) } catch (e) { /* non-fatal */ }
        }
    }, model);
    console.log('[startup] streams starting...')
    await streams.start();
    console.log('[startup] streams started')

    // Basic executor wiring (env KEYPAIR for demo)
    let secret = process.env.KEYPAIR ? Uint8Array.from(JSON.parse(process.env.KEYPAIR)) : undefined as any;
    if (!secret && process.env.KEYPAIR_B58) {
        try {
            const bs58 = await import('bs58');
            secret = bs58.default.decode(process.env.KEYPAIR_B58);
        } catch (e) {
            console.error('Failed to decode KEYPAIR_B58. Ensure bs58 is installed.');
        }
    }
    if (!secret) {
        console.warn('No KEYPAIR in env; execution disabled');
    }
    const payer = secret ? Keypair.fromSecretKey(secret) : undefined as any;
    const conn = new Connection(rpcPrimary, 'confirmed');
    try { await prefetchPumpfunFeeRecipient(conn); } catch { }

    // Optional: backfill recent Pump.fun trades to expand universe at startup
    try {
        const doBackfill = (process.env.BACKFILL_ON_START || 'true').toLowerCase() === 'true'
        if (doBackfill) {
            const limit = Math.max(50, Math.min(1000, Number(process.env.BACKFILL_SIG_LIMIT || 300)))
            console.log(`[startup] backfilling last ${limit} Pump.fun txs...`)
            const oracle = new SolPriceOracle();
            await oracle.start();
            const prog = new PublicKey(PUMPFUN_PROGRAM_ID)
            const sigs = await conn.getSignaturesForAddress(prog, { limit: limit }, 'confirmed')
            for (const s of sigs) {
                try {
                    const trades = await buildTradesFromSignature(conn, s.signature, oracle)
                    const now2 = Date.now() / 1000
                    for (const t of trades) {
                        rolling.update(t as any)
                        seenMints.set(t.token_mint, now2)
                    }
                } catch { }
            }
            console.log(`[startup] backfill complete; unique mints: ${seenMints.size}`)
        }
    } catch { }
    const executor = payer ? new Executor(conn, payer, {
        priorityFeeLamports: Number(process.env.PRIORITY_FEE_LAMPORTS || 0),
        slippageBps: Number(process.env.SLIPPAGE_BPS || 50),
        switchMarginBps: cfg.switchMarginBps,
        impactCapBps: cfg.impactCapBps,
        splitsK: cfg.splitsK,
        sliceDelayMs: cfg.sliceDelayMs,
        // propagate safety flags
        ...(cfg.killSwitch ? { killSwitch: true } : {}),
        ...(cfg.dailyLossLimitUsd > 0 ? { dailyLossLimitUsd: cfg.dailyLossLimitUsd } : {}),
        // routing preferences
        ...(cfg.preferWsol ? { preferWsol: true } : {}),
        allowMints: cfg.allowMints,
        denyMints: cfg.denyMints,
    } as any) : undefined;

    // Dynamic mint universe is built from seen trades

    // Feed rolling windows from streams via /tick postings will be replaced by direct ingestion
    // Minimal: reuse migration + tx parsing; after each tx, update rolling and evaluate
    const originalOnLogs = (streams as any).onLogs.bind(streams)
        ; (streams as any).onLogs = async (logs: any) => {
            await originalOnLogs(logs)
            // buildTradesFromSignature is already called inside onLogs -> model.tick; mirror it here by pulling from txParse? For simplicity, skip duplicating and rely on decisions timer
        }

    setInterval(async () => {
        if (!executor) return
        // Build dynamic mint list: seen within last 15 minutes and with at least 2 trades in base window
        const horizonS = Number(process.env.ACTIVE_MINT_AGE_S || 900)
        const now = Date.now() / 1000
        const baseWindow = 300
        let mints = Array.from(seenMints.entries())
            .filter(([m, ts]) => (now - ts) <= horizonS && (rolling.tradeCount(m, baseWindow) >= 1))
            .map(([m]) => m)
        // Drop mints with no trades in the last 5 minutes (configurable)
        const maxStaleS = Number(process.env.STALE_MINT_MAX_S || 300)
        mints = mints.filter((m) => {
            const age = rolling.lastAgeSeconds(m)
            return age !== undefined && age <= maxStaleS
        })
        // Filter: only consider mints created on Pump.fun (bonding_curve PDA must exist)
        try {
            const pid = new PublicKey(PUMPFUN_PROGRAM_ID)
            const results = await Promise.all(mints.map(async (mint) => {
                const cached = pumpMintCache.get(mint)
                if (cached !== undefined) return [mint, cached] as const
                try {
                    const token = new PublicKey(mint)
                    const [bcPda] = await PublicKey.findProgramAddress([Buffer.from('bonding-curve'), token.toBuffer()], pid)
                    const info = await conn.getAccountInfo(bcPda, 'confirmed')
                    const ok = !!info
                    pumpMintCache.set(mint, ok)
                    return [mint, ok] as const
                } catch {
                    pumpMintCache.set(mint, false)
                    return [mint, false] as const
                }
            }))
            mints = results.filter(([, ok]) => ok).map(([m]) => m)
        } catch { }
        if (mints.length < 3) {
            console.log('[scheduler] waiting: active mints < 3 or insufficient trades')
            return
        }
        // Auto-detect phase: if a PumpSwap pool exists for WSOL/token or USDC/token, set phase=amm
        for (const mint of mints) {
            if (PhaseRegistry.get(mint) === 'amm') continue
            try {
                const token = new PublicKey(mint)
                const wsolOk = await pumpSwapPoolHealthy(conn, new PublicKey(WSOL_MINT), token)
                const usdcOk = await pumpSwapPoolHealthy(conn, new PublicKey(USDC_MINT), token)
                if (wsolOk || usdcOk) {
                    PhaseRegistry.set(mint, 'amm')
                }
            } catch { }
        }
        // Optional pre-warm: remove disk persistence; we only persist for actual buy below
        for (const mint of mints) {
            if (PhaseRegistry.get(mint) === 'curve') {
                try { await prefetchPumpfunCreatorVault(conn, new PublicKey(mint), false) } catch { }
            }
        }
        let decisions: { token_mint: string, action: string, size_usd: number, z_caer?: number, caer?: number }[] = []
        if (model) {
            try {
                decisions = await model.decide(mints)
            } catch { /* fallback to local */ }
        }
        if (!decisions.length) {
            const { caer, z } = alpha.computeCaerAndZ(mints, baseWindow)
            for (const mint of mints) {
                const zv = z[mint]
                if (zv === undefined) continue
                const action = zv >= Number(process.env.Z_ENTRY || 1.0) ? 'buy' : (zv <= Number(process.env.Z_EXIT || 0.5) ? 'exit' : 'hold')
                const size_usd = action === 'buy' ? Number(process.env.ENTRY_USD || 30) : 0
                decisions.push({ token_mint: mint, action, size_usd, z_caer: zv, caer: caer[mint] })
            }
        }
        for (const d of decisions) {
            const { token_mint, action } = d
            const phase = PhaseRegistry.get(token_mint)
            const mm = { base: new PublicKey('So11111111111111111111111111111111111111112'), quote: new PublicKey(USDC_MINT), token: new PublicKey(token_mint) }
            if (action !== 'hold') {
                console.log(`[decision] ${action} ${token_mint} size_usd=${d.size_usd.toFixed(2)} z=${(d.z_caer ?? 0).toFixed(3)} phase=${phase}`)
                try {
                    // Ensure creator_vault is cached before attempting curve buy
                    if (action === 'buy' && phase === 'curve') {
                        try {
                            const ok = await prefetchPumpfunCreatorVault(conn, new PublicKey(token_mint), true)
                            if (!ok) {
                                // Skip curve buy if creator_vault cannot be resolved; fallback to AMM by forcing phase
                                console.warn('[execute][curve] creator_vault unavailable; skipping curve buy and attempting AMM')
                                await (executor as any).execute({ ...d, action: 'buy' } as any, 'amm', mm)
                                continue
                            }
                            // Guard: ensure bonding_curve PDA exists before attempting curve buy
                            try {
                                const pid = new PublicKey(PUMPFUN_PROGRAM_ID)
                                const [bcPda] = await PublicKey.findProgramAddress([Buffer.from('bonding-curve'), mm.token.toBuffer()], pid)
                                const bcInfo = await conn.getAccountInfo(bcPda, 'confirmed')
                                if (!bcInfo) {
                                    console.warn('[execute][curve] bonding_curve not initialized; attempting AMM instead')
                                    await (executor as any).execute({ ...d, action: 'buy' } as any, 'amm', mm)
                                    continue
                                }
                            } catch { }
                        } catch { }
                    }
                    const sigs = await executor.execute(d as any, phase, mm)
                    if (sigs.length) console.log('txids:', sigs.join(','))
                } catch (e) { console.error('execute error', e) }
            }
        }
    }, Number(process.env.SCHEDULER_SECONDS || 5000));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
