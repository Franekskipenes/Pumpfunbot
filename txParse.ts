import { Connection, VersionedTransactionResponse, PublicKey } from '@solana/web3.js';
import { TradeTick } from './modelClient';
import { USDC_MINT, WSOL_MINT, PUMPFUN_PROGRAM_ID } from './constants';
import { SolPriceOracle } from './priceOracle';
import { CurveMidprice } from './curvePrice';

function lamportsToSol(lamports: number): number {
    return lamports / 1_000_000_000;
}

export async function buildTradesFromSignature(
    conn: Connection,
    signature: string,
    solOracle: SolPriceOracle
): Promise<TradeTick[]> {
    const resp: VersionedTransactionResponse | null = await conn.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
    });
    if (!resp || !resp.meta) return [];
    const meta = resp.meta;
    const msg = resp.transaction.message;
    const accountKeys = msg.getAccountKeys ? msg.getAccountKeys().keySegments().flat() : (msg as any).accountKeys;
    const payer = (accountKeys[0] instanceof PublicKey ? accountKeys[0].toBase58() : accountKeys[0].toString());

    // Token balance deltas per mint for payer-owned accounts
    interface BalRec { mint: string; owner: string; uiAmt: number; }
    const pre: BalRec[] = (meta.preTokenBalances || []).map((b) => ({ mint: b.mint!, owner: b.owner!, uiAmt: Number(b.uiTokenAmount.uiAmountString || b.uiTokenAmount.uiAmount || 0) }));
    const post: BalRec[] = (meta.postTokenBalances || []).map((b) => ({ mint: b.mint!, owner: b.owner!, uiAmt: Number(b.uiTokenAmount.uiAmountString || b.uiTokenAmount.uiAmount || 0) }));
    const owners = new Set<string>([payer]);
    const mints = new Set<string>([...pre, ...post].map((r) => r.mint));
    const deltaByMint: Record<string, number> = {};
    for (const m of mints) {
        const preAmt = pre.filter((r) => r.mint === m && owners.has(r.owner)).reduce((a, b) => a + b.uiAmt, 0);
        const postAmt = post.filter((r) => r.mint === m && owners.has(r.owner)).reduce((a, b) => a + b.uiAmt, 0);
        deltaByMint[m] = (postAmt - preAmt);
    }

    // Identify traded non-base mint by absolute largest delta excluding USDC and WSOL
    const entries = Object.entries(deltaByMint).filter(([m]) => m !== USDC_MINT && m !== WSOL_MINT);
    if (entries.length === 0) return [];
    entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const [tokenMint, tokenDelta] = entries[0];
    if (!tokenDelta || tokenDelta === 0) return [];
    const isBuy = tokenDelta > 0;
    const amountTokens = Math.abs(tokenDelta);

    // Determine quote flow: USDC or SOL
    const usdcDelta = deltaByMint[USDC_MINT] || 0;
    const wsolDelta = deltaByMint[WSOL_MINT] || 0;
    // Also consider lamports delta (payer SOL change), which may reflect WSOL unwraps/fees
    const payerIdx = 0;
    const preLamports = meta.preBalances?.[payerIdx] || 0;
    const postLamports = meta.postBalances?.[payerIdx] || 0;
    const solDelta = lamportsToSol(postLamports - preLamports); // negative when spending SOL

    let priceUsd: number | undefined;
    if (usdcDelta !== 0) {
        priceUsd = Math.abs(usdcDelta) / amountTokens;
    } else if (wsolDelta !== 0 || solDelta !== 0) {
        const solSpent = Math.abs(wsolDelta) + Math.abs(solDelta);
        const solUsd = solOracle.get();
        priceUsd = (solSpent * solUsd) / amountTokens;
    } else {
        // On-curve case: try reading curve midprice as fallback when no quote leg delta visible
        const curve = new CurveMidprice(conn);
        const solUsd = solOracle.get();
        const mp = await curve.midpriceUsd(tokenMint, solUsd);
        if (mp && isFinite(mp)) priceUsd = mp;
    }
    if (priceUsd === undefined || !isFinite(priceUsd) || priceUsd <= 0) return [];

    return [{
        timestamp: (resp.blockTime || Math.floor(Date.now() / 1000)),
        token_mint: tokenMint,
        price_usd: priceUsd,
        amount_tokens: amountTokens,
        is_buy: isBuy,
    }];
}
