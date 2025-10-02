import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Decision } from './modelClient';
import { buildRaydiumSwapTx, quoteRaydiumOut } from './tx/raydium';
import { buildPumpSwapTx, pumpSwapPoolHealthy, quotePumpSwapOut } from './tx/pumpswap';
import { buildCurveBuyTx, buildCurveSellTx } from './tx/curve';
import { splitAndExecute } from './tx/execute';
import { getFreezeAuthorityAndOwnerProgram } from './mint';
import { WSOL_MINT } from './constants';
import { buildWrapWsolIxs, buildUnwrapWsolIxs } from './tx/wsol';
import { getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

export interface ExecConfig {
    priorityFeeLamports: number;
    slippageBps: number;
    switchMarginBps: number;
    impactCapBps: number;
    splitsK: number;
    sliceDelayMs: number;
    // optional safety flags carried from env/config
    killSwitch?: boolean;
    dailyLossLimitUsd?: number;
    preferWsol?: boolean;
    denyMints?: Set<string>;
    allowMints?: Set<string>;
}

export type Phase = 'curve' | 'amm';

export class Executor {
    private dailyPnlUsd = 0;
    private lastPnlResetDay?: number;
    constructor(private readonly conn: Connection, private readonly payer: Keypair, private readonly cfg: ExecConfig) { }

    async execute(decision: Decision, phase: Phase, mints: { base: PublicKey; quote: PublicKey; token: PublicKey }) {
        // Kill switch and daily limit check
        const today = new Date().getUTCDate();
        if (this.lastPnlResetDay === undefined) this.lastPnlResetDay = today;
        if (today !== this.lastPnlResetDay) { this.dailyPnlUsd = 0; this.lastPnlResetDay = today; }
        if ((this.cfg as any).killSwitch) { console.warn('Kill switch active'); return []; }
        const limit = (this.cfg as any).dailyLossLimitUsd || 0;
        if (limit > 0 && this.dailyPnlUsd <= -limit) { console.warn('Daily loss limit reached'); return []; }
        if (decision.action === 'hold') return [];
        // Determine amountInAtoms depending on route and action
        let amountInAtoms = 0n as bigint;
        const usdcDecimals = 6n;
        const wsolDecimals = 9n;
        if (decision.action === 'buy') {
            const preferWsol = !!(this.cfg as any).preferWsol;
            if (preferWsol) {
                const solUsd = Number(process.env.SOL_USD_HINT || 150);
                const lamports = Math.max(0, Math.floor((decision.size_usd / Math.max(solUsd, 1e-6)) * 10 ** Number(wsolDecimals)));
                amountInAtoms = BigInt(lamports);
            } else {
                amountInAtoms = BigInt(Math.floor(decision.size_usd * 10 ** Number(usdcDecimals)));
            }
        }
        if (phase === 'curve') {
            if ((process.env.DISABLE_CURVE_BUY || '').toLowerCase() === 'true' && decision.action === 'buy') {
                console.warn('[execute][curve] buy disabled by env DISABLE_CURVE_BUY=true');
                return [];
            }
            if (decision.action === 'buy') {
                const tx = await buildCurveBuyTx(this.conn, {
                    payer: this.payer.publicKey,
                    inputMint: mints.quote,
                    outputMint: mints.token,
                    amountInAtoms,
                    slippageBps: this.cfg.slippageBps,
                    priorityFeeLamports: this.cfg.priorityFeeLamports,
                });
                const sigs = await splitAndExecute(this.conn, [tx.transaction], this.payer, { preflight: true, maxRetries: 3 });
                if (sigs.length) this.dailyPnlUsd -= decision.size_usd;
                console.log(`[execute][curve] buy ${mints.token.toBase58()} usd=${decision.size_usd.toFixed(2)} sigs=${sigs.length}`)
                return sigs;
            }
            if (decision.action === 'exit') {
                // Sell entire token balance
                const ata = getAssociatedTokenAddressSync(mints.token, this.payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
                const balInfo = await this.conn.getTokenAccountBalance(ata).catch(() => undefined);
                const amt = balInfo?.value?.amount ? BigInt(balInfo.value.amount as any as string) : 0n;
                if (amt <= 0n) return [];
                const tx = await buildCurveSellTx(this.conn, {
                    payer: this.payer.publicKey,
                    inputMint: mints.token,
                    outputMint: mints.base,
                    amountInAtoms: amt,
                    slippageBps: this.cfg.slippageBps,
                    priorityFeeLamports: this.cfg.priorityFeeLamports,
                });
                const sigs = await splitAndExecute(this.conn, [tx.transaction], this.payer, { preflight: true, maxRetries: 3 });
                console.log(`[execute][curve] exit ${mints.token.toBase58()} atoms=${amt.toString()} sigs=${sigs.length}`)
                return sigs;
            }
        }
        // AMM path with venue selection: default PumpSwap, fallback Raydium under conditions
        if (phase === 'amm') {
            // Route preference: WSOL first then USDC; allow two-hop (USDC<->WSOL<->token)
            const preferWsol = !!(this.cfg as any).preferWsol;
            let quotePrimary = preferWsol ? mints.base : mints.quote;
            if (decision.action === 'exit') {
                // target output in USDC for clarity
                quotePrimary = mints.quote;
            }
            let inMint = decision.action === 'buy' ? quotePrimary : mints.token;
            let outMint = decision.action === 'buy' ? mints.token : quotePrimary;
            // If primary route not viable, we can later switch to secondary; two-hop can be added similarly
            // Deny/allow mints
            const tokenMintStr = mints.token.toBase58();
            // @ts-ignore cfg has deny/allow in runtime via loadConfig; if absent, treat as empty sets
            const deny: Set<string> = (this.cfg as any).denyMints || new Set();
            const allow: Set<string> = (this.cfg as any).allowMints || new Set();
            if (deny.has(tokenMintStr)) {
                console.warn('Denied by config:', tokenMintStr);
                return [];
            }
            if (allow.size > 0 && !allow.has(tokenMintStr)) {
                console.warn('Not in allow list:', tokenMintStr);
                return [];
            }
            // Block Token-2022 with TransferFee/Hook by default and mints with freeze authority unless explicitly allowed
            const { freeze, mintAuthority, ownerProgram } = await getFreezeAuthorityAndOwnerProgram(this.conn, mints.token);
            const blockFreeze = (process.env.BLOCK_FREEZE || 'true').toLowerCase() === 'true';
            const blockMintAuth = (process.env.BLOCK_MINT_AUTH || 'true').toLowerCase() === 'true';
            if (blockFreeze && freeze) { console.warn('Blocked: freeze authority active'); return []; }
            if (blockMintAuth && mintAuthority) { console.warn('Blocked: mint authority active'); return []; }
            if (ownerProgram && ownerProgram !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
                console.warn('Blocked: non-standard token program (possible Token-2022 fees/hooks)');
                return [];
            }
            let venue: 'pumpswap' | 'raydium' = 'pumpswap';
            const healthy = await pumpSwapPoolHealthy(this.conn, inMint, outMint);
            if (!healthy) venue = 'raydium';

            // Compare cost/impact ex-ante if both quotes available
            let estExitUsd = 0;
            try {
                if (decision.action === 'exit') {
                    const ata = getAssociatedTokenAddressSync(mints.token, this.payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
                    const balInfo = await this.conn.getTokenAccountBalance(ata).catch(() => undefined);
                    const amt = balInfo?.value?.amount ? BigInt(balInfo.value.amount as any as string) : 0n;
                    if (amt <= 0n) return [];
                    amountInAtoms = amt;
                    inMint = mints.token;
                    outMint = quotePrimary;
                }
                const [pq, rq] = await Promise.all([
                    quotePumpSwapOut(this.conn, inMint, outMint, amountInAtoms),
                    quoteRaydiumOut(this.conn, inMint, outMint, amountInAtoms),
                ]);
                if (pq && rq) {
                    // cost_bps ~ (amountIn - out*px)/amountIn proxy; compare using impact_bps and out
                    const worseByBps = (rq.impactBps - pq.impactBps);
                    if (worseByBps <= -this.cfg.switchMarginBps) venue = 'raydium';
                    const cap = this.cfg.impactCapBps;
                    if (pq.impactBps > cap && rq.impactBps <= cap) venue = 'raydium';
                    // Per-slice input reserve check: planned slice <= 1% of input reserve
                    const inReserve = venue === 'pumpswap' ? pq.reserveInAtoms : rq.reserveInAtoms;
                    const onePercent = inReserve / 100n;
                    if (amountInAtoms > onePercent && (venue === 'pumpswap' ? pq.impactBps : rq.impactBps) > cap) {
                        // Suggest higher K by caller context; here, fallback to raydium if it passes
                        if (venue !== 'raydium' && rq.impactBps <= cap) venue = 'raydium';
                    }
                    // Health: last swap < 30s and reserves changed within 3 slots (approx via quote slot freshness)
                    const now = Date.now() / 1000;
                    const slotNow = await this.conn.getSlot('confirmed');
                    const pumpFresh = (now - pq.ts) <= 30 && (slotNow - pq.slot) <= 3;
                    const rayFresh = (now - rq.ts) <= 30 && (slotNow - rq.slot) <= 3;
                    if (venue === 'pumpswap' && !pumpFresh && rayFresh) venue = 'raydium';
                    if (venue === 'raydium' && !rayFresh && pumpFresh) venue = 'pumpswap';
                }
                // Estimate exit proceeds in USD if exiting to USDC
                if (decision.action === 'exit') {
                    const chosen = venue === 'pumpswap' ? pq : rq;
                    if (chosen && outMint.equals(mints.quote)) {
                        estExitUsd = Number(chosen.outAtoms) / 1_000_000;
                    }
                }
            } catch { }
            // K-slice execution with fixed venue for this batch
            const k = Math.max(1, this.cfg.splitsK);
            const slice = amountInAtoms / BigInt(k);
            const txs = [] as any[];
            for (let i = 0; i < k; i++) {
                const amt = i === k - 1 ? (amountInAtoms - slice * BigInt(k - 1)) : slice;
                const preIxs = [] as any[]; const postIxs = [] as any[];
                // WSOL handling: if input mint is WSOL, wrap; if output is WSOL, ensure unwrap after
                const wsolPk = new PublicKey(WSOL_MINT);
                if (inMint.equals(wsolPk)) {
                    const wrap = await buildWrapWsolIxs(this.conn, this.payer.publicKey, this.payer.publicKey, amt);
                    preIxs.push(...wrap.ixs);
                }
                if (outMint.equals(wsolPk)) {
                    const unwrap = buildUnwrapWsolIxs(this.payer.publicKey);
                    postIxs.push(...unwrap.ixs);
                }
                if (venue === 'pumpswap') {
                    try {
                        const tx = await buildPumpSwapTx(this.conn, {
                            payer: this.payer.publicKey,
                            inputMint: inMint,
                            outputMint: outMint,
                            amountInAtoms: amt,
                            slippageBps: this.cfg.slippageBps,
                            priorityFeeLamports: this.cfg.priorityFeeLamports,
                            preIxs,
                            postIxs,
                        });
                        txs.push(tx.transaction);
                    } catch {
                        // fallback all remaining to raydium
                        venue = 'raydium';
                        i--; // redo this slice on raydium
                        continue;
                    }
                } else {
                    const tx = await buildRaydiumSwapTx(this.conn, {
                        payer: this.payer.publicKey,
                        inputMint: inMint,
                        outputMint: outMint,
                        amountInAtoms: amt,
                        slippageBps: this.cfg.slippageBps,
                        priorityFeeLamports: this.cfg.priorityFeeLamports,
                        preIxs,
                        postIxs,
                    });
                    txs.push(tx.transaction);
                }
                if (this.cfg.sliceDelayMs > 0 && i < k - 1) await new Promise(r => setTimeout(r, this.cfg.sliceDelayMs));
            }
            const sigs = await splitAndExecute(this.conn, txs, this.payer, { preflight: true, maxRetries: 3 });
            // Update PnL estimate: conservative, assume spend = amountIn (quote) and unrealized handled elsewhere.
            if (sigs.length) {
                if (decision.action === 'buy') this.dailyPnlUsd -= decision.size_usd;
                if (decision.action === 'exit' && estExitUsd > 0) this.dailyPnlUsd += estExitUsd;
            }
            console.log(`[execute][${venue}] ${decision.action} ${mints.token.toBase58()} k=${this.cfg.splitsK} sigs=${sigs.length}`)
            return sigs;
        }
        return [];
    }
}
