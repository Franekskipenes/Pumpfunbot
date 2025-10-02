import { Connection, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createCloseAccountInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createSyncNativeInstruction } from '@solana/spl-token'

export const WSOL_MINT_PK = new PublicKey('So11111111111111111111111111111111111111112')

export async function buildWrapWsolIxs(conn: Connection, payer: PublicKey, owner: PublicKey, amountLamports: bigint): Promise<{ ata: PublicKey, ixs: TransactionInstruction[] }> {
    const ata = getAssociatedTokenAddressSync(WSOL_MINT_PK, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
    const ixs: TransactionInstruction[] = []
    const info = await conn.getAccountInfo(ata)
    if (!info) {
        ixs.push(createAssociatedTokenAccountInstruction(payer, ata, owner, WSOL_MINT_PK, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID))
    }
    ixs.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: ata, lamports: Number(amountLamports) }))
    ixs.push(createSyncNativeInstruction(ata))
    return { ata, ixs }
}

export function buildUnwrapWsolIxs(owner: PublicKey): { ata: PublicKey, ixs: TransactionInstruction[] } {
    const ata = getAssociatedTokenAddressSync(WSOL_MINT_PK, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
    const ixs: TransactionInstruction[] = [createCloseAccountInstruction(ata, owner, owner)]
    return { ata, ixs }
}


