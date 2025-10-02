import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
    Liquidity,
    MAINNET_PROGRAM_ID,
    Percent,
    Token,
    TokenAmount,
    jsonInfo2PoolKeys,
} from '@raydium-io/raydium-sdk';
import { SwapParams, withPriorityFee, buildV0Tx, BuiltTx } from './builder';

type PoolJson = any;

async function fetchRaydiumPools(): Promise<PoolJson[]> {
    const url = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`raydium pools fetch failed: ${res.status}`);
    const json = await res.json();
    const all: PoolJson[] = [];
    for (const key of Object.keys(json)) {
        const arr = json[key];
        if (Array.isArray(arr)) all.push(...arr);
    }
    return all;
}

function pickPoolByMints(pools: PoolJson[], a: string, b: string): PoolJson | undefined {
    return pools.find((p) => (
        (p.baseMint === a && p.quoteMint === b) ||
        (p.baseMint === b && p.quoteMint === a)
    ));
}

export async function buildRaydiumSwapTx(conn: Connection, params: SwapParams): Promise<BuiltTx> {
    const inputMintStr = params.inputMint.toBase58();
    const outputMintStr = params.outputMint.toBase58();
    const pools = await fetchRaydiumPools();
    const poolJson = pickPoolByMints(pools, inputMintStr, outputMintStr);
    if (!poolJson) throw new Error('raydium pool not found for mint pair');
    const poolKeys = jsonInfo2PoolKeys(poolJson);

    const inputIsBase = poolJson.baseMint === inputMintStr;
    const inDecimals = inputIsBase ? Number(poolJson.baseDecimals) : Number(poolJson.quoteDecimals);
    const outDecimals = inputIsBase ? Number(poolJson.quoteDecimals) : Number(poolJson.baseDecimals);
    const tokenIn = new Token(MAINNET_PROGRAM_ID.TOKEN_PROGRAM_ID, params.inputMint, inDecimals);
    const tokenOut = new Token(MAINNET_PROGRAM_ID.TOKEN_PROGRAM_ID, params.outputMint, outDecimals);

    const amountIn = new TokenAmount(tokenIn, params.amountInAtoms.toString());
    const slippage = new Percent(params.slippageBps, 10_000);

    const poolInfo = await Liquidity.fetchInfo({ connection: conn, poolKeys });
    const { minAmountOut } = Liquidity.computeAmountOut({
        poolKeys,
        poolInfo,
        amountIn,
        currencyOut: tokenOut,
        slippage,
    });

    const sdk = await import('@raydium-io/raydium-sdk');
    const tokenAccounts = await (sdk as any).getWalletTokenAccounts(conn, params.payer);

    const { innerTransaction } = await Liquidity.makeSwapInstructionSimple({
        connection: conn,
        poolKeys,
        userKeys: { tokenAccounts, owner: params.payer, payer: params.payer },
        amountIn,
        amountOut: minAmountOut,
        fixedSide: 'in',
        slippage,
        computeBudgetConfig: params.priorityFeeLamports ? { microLamports: params.priorityFeeLamports } : undefined,
    });

    const ixs: TransactionInstruction[] = [...(params.preIxs || []), ...(innerTransaction.instructions as TransactionInstruction[]), ...(params.postIxs || [])];
    const ixsWithFee = await withPriorityFee(ixs, params.priorityFeeLamports);
    const tx = await buildV0Tx(conn, params.payer, ixsWithFee);
    return { transaction: tx };
}

export async function quoteRaydiumOut(conn: Connection, inputMint: PublicKey, outputMint: PublicKey, amountInAtoms: bigint): Promise<{ outAtoms: bigint, impactBps: number, reserveInAtoms: bigint, reserveOutAtoms: bigint, slot: number, ts: number, poolId: string } | undefined> {
    try {
        const inputMintStr = inputMint.toBase58();
        const outputMintStr = outputMint.toBase58();
        const pools = await fetchRaydiumPools();
        const poolJson = pickPoolByMints(pools, inputMintStr, outputMintStr);
        if (!poolJson) return undefined;
        const poolKeys = jsonInfo2PoolKeys(poolJson);
        const inputIsBase = poolJson.baseMint === inputMintStr;
        const inDecimals = inputIsBase ? Number(poolJson.baseDecimals) : Number(poolJson.quoteDecimals);
        const outDecimals = inputIsBase ? Number(poolJson.quoteDecimals) : Number(poolJson.baseDecimals);
        const tokenIn = new Token(MAINNET_PROGRAM_ID.TOKEN_PROGRAM_ID, inputMint, inDecimals);
        const tokenOut = new Token(MAINNET_PROGRAM_ID.TOKEN_PROGRAM_ID, outputMint, outDecimals);
        const amountIn = new TokenAmount(tokenIn, amountInAtoms.toString());
        const poolInfo = await Liquidity.fetchInfo({ connection: conn, poolKeys });
        const { amountOut } = Liquidity.computeAmountOut({ poolKeys, poolInfo, amountIn, currencyOut: tokenOut, slippage: new Percent(0, 10_000) });
        // approximate impact using small slippage calc
        const { minAmountOut } = Liquidity.computeAmountOut({ poolKeys, poolInfo, amountIn, currencyOut: tokenOut, slippage: new Percent(50, 10_000) });
        const impact = Math.max(0, (Number(amountOut.numerator) - Number(minAmountOut.numerator)) / Number(amountOut.numerator)) * 10_000;
        // Reserves (approx) from poolInfo
        const inIsBase = poolJson.baseMint === inputMintStr;
        const rBase = BigInt(poolInfo.baseReserve.toString());
        const rQuote = BigInt(poolInfo.quoteReserve.toString());
        const reserveInAtoms = inIsBase ? rBase : rQuote;
        const reserveOutAtoms = inIsBase ? rQuote : rBase;
        const slot = await conn.getSlot('confirmed');
        const ts = Date.now() / 1000;
        const poolId = poolJson.id || poolJson.ammId || `${poolJson.baseMint}-${poolJson.quoteMint}`;
        return { outAtoms: BigInt(amountOut.raw.toString()), impactBps: impact, reserveInAtoms, reserveOutAtoms, slot, ts, poolId };
    } catch {
        return undefined;
    }
}
