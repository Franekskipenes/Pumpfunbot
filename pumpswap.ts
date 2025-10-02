import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { SwapParams, withPriorityFee, buildV0Tx, BuiltTx } from './builder'

type PoolJson = any

// Minimal PumpSwap builder using SDK dynamic import to avoid hard-coupling types
export async function buildPumpSwapTx(conn: Connection, params: SwapParams): Promise<BuiltTx> {
    const sdk = await import('@pump-fun/pump-swap-sdk') as any
    const ixs: TransactionInstruction[] = []

    // Fetch pool for the pair
    const pool = await (sdk as any).findPoolByMints(conn, params.inputMint.toBase58(), params.outputMint.toBase58())
    if (!pool) throw new Error('pumpswap pool not found')

    // Resolve user token accounts
    const ataIn = getAssociatedTokenAddressSync(params.inputMint, params.payer, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
    const ataOut = getAssociatedTokenAddressSync(params.outputMint, params.payer, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)

    // Build swap ix via SDK
    const ix = await (sdk as any).buildSwapInstruction({
        connection: conn,
        pool,
        user: params.payer,
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amountIn: params.amountInAtoms, // bigint
        slippageBps: params.slippageBps,
        ataIn,
        ataOut,
    })
    ixs.push(...(params.preIxs || []))
    ixs.push(ix)
    ixs.push(...(params.postIxs || []))

    const ixsWithFee = await withPriorityFee(ixs, params.priorityFeeLamports)
    const tx = await buildV0Tx(conn, params.payer, ixsWithFee)
    return { transaction: tx }
}

export async function pumpSwapPoolHealthy(conn: Connection, inputMint: PublicKey, outputMint: PublicKey): Promise<boolean> {
    try {
        const sdk = await import('@pump-fun/pump-swap-sdk') as any
        const pool = await (sdk as any).findPoolByMints(conn, inputMint.toBase58(), outputMint.toBase58())
        if (!pool) return false
        // Basic health: has vaults and recent slot
        const info = await conn.getAccountInfo(new PublicKey(pool.id))
        if (!info) return false
        const current = await conn.getSlot('confirmed')
        // stale if older than 3 slots (heuristic)
        return current - (info.context?.slot ?? current) <= 3
    } catch {
        return false
    }
}

async function getMintDecimals(conn: Connection, mint: PublicKey): Promise<number> {
    const info = await conn.getParsedAccountInfo(mint)
    // @ts-ignore
    const dec = info.value?.data?.parsed?.info?.decimals
    if (typeof dec === 'number') return dec
    return 9
}

export async function quotePumpSwapOut(conn: Connection, inputMint: PublicKey, outputMint: PublicKey, amountInAtoms: bigint): Promise<{ outAtoms: bigint, impactBps: number, reserveInAtoms: bigint, reserveOutAtoms: bigint, slot: number, ts: number, poolId: string } | undefined> {
    try {
        const sdk = await import('@pump-fun/pump-swap-sdk') as any
        const pool = await (sdk as any).findPoolByMints(conn, inputMint.toBase58(), outputMint.toBase58())
        if (!pool) return undefined
        // Attempt to read vault accounts
        const aVaultStr = pool.vaultA || pool.baseVault || pool.tokenAVault
        const bVaultStr = pool.vaultB || pool.quoteVault || pool.tokenBVault
        if (!aVaultStr || !bVaultStr) return undefined
        const aVault = new PublicKey(aVaultStr)
        const bVault = new PublicKey(bVaultStr)
        const [aBal, bBal] = await Promise.all([
            conn.getTokenAccountBalance(aVault),
            conn.getTokenAccountBalance(bVault)
        ])
        const aMint = new PublicKey(pool.mintA || pool.baseMint)
        const bMint = new PublicKey(pool.mintB || pool.quoteMint)
        const aIsInput = aMint.equals(inputMint)
        const x = BigInt(aIsInput ? (aBal.value.amount as any as string) : (bBal.value.amount as any as string))
        const y = BigInt(aIsInput ? (bBal.value.amount as any as string) : (aBal.value.amount as any as string))
        const dx = amountInAtoms
        const feeBps = Number(pool.feeBps || 25)
        const dxAfterFee = dx * BigInt(10_000 - feeBps) / 10_000n
        const newX = x + dxAfterFee
        const k = x * y
        const newY = k / newX
        const out = y - newY
        // price impact bps
        const priceBefore = Number(y) / Number(x)
        const priceAfter = Number(newY) / Number(newX)
        const impact = Math.abs(priceAfter - priceBefore) / priceBefore * 10_000
        const slot = await conn.getSlot('confirmed')
        const ts = Date.now() / 1000
        const poolId = pool.id || `${pool.baseMint}-${pool.quoteMint}`
        return { outAtoms: out, impactBps: impact, reserveInAtoms: x, reserveOutAtoms: y, slot, ts, poolId }
    } catch {
        return undefined
    }
}

