import { Connection, VersionedTransaction, Keypair } from '@solana/web3.js';

export interface ExecuteOptions {
    maxRetries?: number;
    preflight?: boolean;
    confirmCommitment?: 'processed' | 'confirmed' | 'finalized';
}

export async function simulate(conn: Connection, tx: VersionedTransaction): Promise<void> {
    await conn.simulateTransaction(tx, { replaceRecentBlockhash: true });
}

export async function sendAndConfirm(conn: Connection, tx: VersionedTransaction, signer: Keypair, opts: ExecuteOptions = {}): Promise<string> {
    const maxRetries = opts.maxRetries ?? 3;
    const confirm = opts.confirmCommitment ?? 'confirmed';
    let lastErr: any;
    for (let i = 0; i < maxRetries; i++) {
        try {
            tx.sign([signer]);
            const sig = await conn.sendTransaction(tx, { skipPreflight: !opts.preflight, maxRetries: 2 });
            await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, confirm);
            return sig;
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr;
}

export async function splitAndExecute(conn: Connection, txs: VersionedTransaction[], signer: Keypair, opts: ExecuteOptions = {}): Promise<string[]> {
    const sigs: string[] = [];
    for (const tx of txs) {
        if (opts.preflight) {
            await simulate(conn, tx);
        }
        sigs.push(await sendAndConfirm(conn, tx, signer, opts));
    }
    return sigs;
}
