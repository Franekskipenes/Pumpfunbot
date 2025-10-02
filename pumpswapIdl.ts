import type { Idl } from '@coral-xyz/anchor'

let cached: Idl | undefined

export async function loadPumpswapIdl(): Promise<Idl> {
    if (cached) return cached
    // Prefer explicit URL if provided, else official docs repo, then fallback to SDK export
    const url = process.env.PUMPSWAP_IDL_URL || 'https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pumpswap.json'
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Failed to fetch PumpSwap IDL: ${res.status}`)
    cached = (await res.json()) as Idl
    if (!cached) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const sdk = require('@pump-fun/pump-swap-sdk')
            if (sdk && sdk.IDL) cached = sdk.IDL as Idl
        } catch { }
    }
    return cached
}


