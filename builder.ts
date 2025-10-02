import { Connection, PublicKey, TransactionInstruction, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

export interface SwapParams {
    payer: PublicKey;
    inputMint: PublicKey;
    outputMint: PublicKey;
    amountInAtoms: bigint; // in input mint atoms
    slippageBps: number;
    priorityFeeLamports?: number;
    preIxs?: TransactionInstruction[];
    postIxs?: TransactionInstruction[];
}

export interface BuiltTx {
    transaction: VersionedTransaction;
}

export async function withPriorityFee(ixs: TransactionInstruction[], lamports?: number): Promise<TransactionInstruction[]> {
    if (!lamports || lamports <= 0) return ixs;
    return [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: lamports }), ...ixs];
}

export async function buildV0Tx(conn: Connection, payer: PublicKey, ixs: TransactionInstruction[]): Promise<VersionedTransaction> {
    const { blockhash } = await conn.getLatestBlockhash('finalized');
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    return new VersionedTransaction(msg);
}
