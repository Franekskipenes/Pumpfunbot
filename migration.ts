import { Connection, Logs, PublicKey } from '@solana/web3.js';
import { PUMPFUN_PROGRAM_ID, PUMPSWAP_PROGRAM_ID } from './constants';
import { ModelClient } from './modelClient';
import { PhaseRegistry } from './phaseRegistry';
import { Program, AnchorProvider } from '@coral-xyz/anchor';
import { loadPumpfunIdl } from './pumpfunIdl';
import { loadPumpswapIdl } from './pumpswapIdl';

interface MigrationState {
    [mint: string]: { haltedAtSlot?: number; migratedAtSlot?: number };
}

export class MigrationDetector {
    private state: MigrationState = {};
    private pumpProgram?: Program;
    private swapProgram?: Program;
    constructor(private readonly conn: Connection, private readonly model?: ModelClient) { }

    async onLogs(logs: Logs) {
        const prog = logs.programId?.toBase58?.() || '';
        if (prog === PUMPFUN_PROGRAM_ID && !this.pumpProgram) {
            const idl = await loadPumpfunIdl();
            this.pumpProgram = new Program(idl, new PublicKey(PUMPFUN_PROGRAM_ID), new AnchorProvider(this.conn, {} as any, {})) as any;
        }
        if (prog === PUMPSWAP_PROGRAM_ID && !this.swapProgram) {
            const idl = await loadPumpswapIdl();
            this.swapProgram = new Program(idl, new PublicKey(PUMPSWAP_PROGRAM_ID), new AnchorProvider(this.conn, {} as any, {})) as any;
        }
        // Use IDL-derived instruction names from logs
        const text = logs.logs.join('\n');
        if (prog === PUMPFUN_PROGRAM_ID) {
            // Graduation/migration is triggered by admin `withdraw` on Pump.fun
            const migrateHit = /instruction:\s*withdraw/i.test(text) || /\bwithdraw\b/i.test(text);
            const mint = this.extractMint(text);
            if (migrateHit && mint) {
                this.ensure(mint);
                this.state[mint].haltedAtSlot = logs.slot;
                PhaseRegistry.set(mint, 'curve');
                return;
            }
        }
        if (prog === PUMPSWAP_PROGRAM_ID) {
            // PumpSwap pool creation instruction name in IDL: `create_pool`
            const initHit = /instruction:\s*create[_\s-]?pool/i.test(text) || /\bcreate[_\s-]?pool\b/i.test(text);
            const mint = this.extractMint(text);
            if (initHit && mint) {
                this.ensure(mint);
                this.state[mint].migratedAtSlot = logs.slot;
                if (this.model?.phase) { await this.model.phase(mint, 'amm'); }
                PhaseRegistry.set(mint, 'amm');
            }
        }
    }

    private ensure(mint: string) {
        if (!this.state[mint]) this.state[mint] = {};
    }

    private extractMint(text: string): string | undefined {
        const m = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
        return m?.[0];
    }
}
