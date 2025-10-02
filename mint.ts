import { Connection, PublicKey } from '@solana/web3.js'

export async function getMintDecimals(conn: Connection, mint: PublicKey): Promise<number> {
    const info = await conn.getParsedAccountInfo(mint)
    // @ts-ignore
    const dec = info.value?.data?.parsed?.info?.decimals
    if (typeof dec === 'number') return dec
    return 9
}

export async function getFreezeAuthorityAndOwnerProgram(conn: Connection, mint: PublicKey): Promise<{ freeze?: string, mintAuthority?: string, ownerProgram: string | undefined }> {
    const info = await conn.getParsedAccountInfo(mint)
    // @ts-ignore
    const parsed = info.value?.data?.parsed?.info
    const freeze = parsed?.freezeAuthority
    const mintAuthority = parsed?.mintAuthority
    const ownerProgram = (info.value as any)?.owner?.toBase58?.() || (info.value as any)?.owner
    return { freeze, mintAuthority, ownerProgram }
}


