import { Connection, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider, Idl } from '@coral-xyz/anchor';
import { PUMPFUN_PROGRAM_ID } from './constants';
import { loadPumpfunIdl } from './pumpfunIdl';

function toCamel(name: string): string {
    // Convert Anchor account name to camelCase accessor (e.g., CurveState -> curveState, bonding_curve -> bondingCurve)
    if (!name) return name;
    // If already CamelCase: just lower first char
    if (/^[A-Za-z]+$/.test(name) && /[A-Z]/.test(name[0])) {
        return name[0].toLowerCase() + name.slice(1);
    }
    // Replace delimiters and camelize
    return name
        .split(/[_\-\s]+/)
        .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
        .join('');
}

export class CurveMidprice {
    private program?: Program;
    constructor(private readonly conn: Connection) {
        // lazy init
    }

    // Derive curve state PDA from IDL seeds where available; fallback to common seed names.
    private async deriveCurveStatePda(mint: PublicKey): Promise<PublicKey> {
        const programId = new PublicKey(PUMPFUN_PROGRAM_ID);
        try {
            const idl: Idl = await loadPumpfunIdl();
            // Look for an instruction that references a curve/bondingCurve account with PDA seeds
            const candidateAccountNames = new Set<string>();
            for (const acc of idl.accounts || []) {
                const n = acc.name.toLowerCase();
                if (n.includes('curve')) candidateAccountNames.add(acc.name);
                if (n.includes('bonding')) candidateAccountNames.add(acc.name);
            }
            for (const ix of idl.instructions || []) {
                const accounts: any[] = (ix as any).accounts || [];
                for (const a of accounts) {
                    if (!a?.name) continue;
                    if (!candidateAccountNames.has(a.name)) continue;
                    const pda = (a as any).pda;
                    if (!pda?.seeds) continue;
                    const seedBuffers: Buffer[] = [];
                    for (const s of pda.seeds) {
                        if (s.kind === 'const' && typeof s.value === 'string') {
                            seedBuffers.push(Buffer.from(s.value));
                        } else if (s.kind === 'account' && typeof s.path === 'string') {
                            if (s.path.toLowerCase().includes('mint')) seedBuffers.push(mint.toBuffer());
                        } else if (s.kind === 'arg') {
                            // cannot resolve without ix args; skip
                        }
                    }
                    if (seedBuffers.length > 0) {
                        const [pdaKey] = await PublicKey.findProgramAddress(seedBuffers, programId);
                        return pdaKey;
                    }
                }
            }
        } catch { }
        // Fallback common seed guesses
        const seeds = [
            [Buffer.from('bonding-curve'), mint.toBuffer()],
            [Buffer.from('bonding_curve'), mint.toBuffer()],
            [Buffer.from('bondingcurve'), mint.toBuffer()],
            [Buffer.from('curve'), mint.toBuffer()],
        ];
        for (const ss of seeds) {
            const [pda] = await PublicKey.findProgramAddress(ss, programId);
            // Optionally we could probe account existence here, but that requires RPC; return first
            return pda;
        }
        // Should never reach; return a default
        const [pda] = await PublicKey.findProgramAddress([Buffer.from('curve'), mint.toBuffer()], programId);
        return pda;
    }

    async midpriceUsd(mint: string, solUsd: number): Promise<number | undefined> {
        try {
            const mintPk = new PublicKey(mint);
            const statePda = await this.deriveCurveStatePda(mintPk);
            if (!this.program) {
                const idl: Idl = await loadPumpfunIdl();
                const provider = new AnchorProvider(this.conn, {} as any, {});
                this.program = new Program(idl, new PublicKey(PUMPFUN_PROGRAM_ID), provider);
            }
            const idl: Idl = await loadPumpfunIdl();
            // Heuristically determine the curve account name from IDL
            const curveAcc = (idl.accounts || []).find((a) => a.name.toLowerCase().includes('curve') || a.name.toLowerCase().includes('bonding'));
            const accountKey = curveAcc ? toCamel(curveAcc.name) : 'curveState';
            // @ts-ignore dynamic access based on IDL
            const acct: any = await (this.program as any).account[accountKey].fetch(statePda);
            // Field names from IDL: choose among common candidates
            const vBase = Number(
                acct.virtualBase ?? acct.baseVirtual ?? acct.baseVirtualReserves ?? acct.virtualSolReserves ?? acct.virtualSol ?? 0
            );
            const vQuote = Number(
                acct.virtualQuote ?? acct.quoteVirtual ?? acct.quoteVirtualReserves ?? acct.virtualTokenReserves ?? acct.virtualToken ?? 0
            );
            if (!vBase || !vQuote) return undefined;
            // price in quote/base
            const p = vQuote / vBase;
            // Pump.fun curve quote typically in SOL; convert to USD via SOL price
            return p * solUsd;
        } catch {
            return undefined;
        }
    }
}
