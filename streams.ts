import { Connection, Logs, LogsFilter, PublicKey } from '@solana/web3.js';
import { ModelClient, TradeTick } from './modelClient';
import { buildTradesFromSignature } from './txParse';
import { SolPriceOracle } from './priceOracle';
import { RpcManager } from './rpc';
import { MigrationDetector } from './migration';

export interface StreamsConfig {
    rpcUrl: string;
    programIds: string[]; // Pump.fun / PumpSwap/Raydium
}

export class Streams {
    private rpc!: RpcManager;
    private conn: Connection;
    private subIds: number[] = [];
    private oracle = new SolPriceOracle();
    private migration?: MigrationDetector;
    private model?: ModelClient;
    private onTrades?: (trades: TradeTick[]) => Promise<void> | void;

    constructor(private readonly cfg: StreamsConfig, onTrades?: (trades: TradeTick[]) => Promise<void> | void, model?: ModelClient) {
        this.rpc = new RpcManager([cfg.rpcUrl, process.env.SOL_RPC_URL_FAILOVER || ''], [process.env.SOL_WS_URL || '', process.env.SOL_WS_URL_FAILOVER || '']);
        this.conn = this.rpc.getConnection();
        this.onTrades = onTrades;
        this.model = model;
    }

    async start(): Promise<void> {
        await this.oracle.start();
        this.migration = new MigrationDetector(this.conn, this.model);
        // Subscribe per program id to avoid provider issues with mentions[]
        for (const pid of this.cfg.programIds) {
            try {
                const id = this.conn.onLogs(new PublicKey(pid), (l) => this.onLogs(l));
                this.subIds.push(id);
            } catch (e) {
                // try failover once for this pid
                await this.failover();
                try {
                    const id = this.conn.onLogs(new PublicKey(pid), (l) => this.onLogs(l));
                    this.subIds.push(id);
                } catch { }
            }
        }
    }

    async stop(): Promise<void> {
        for (const id of this.subIds) {
            try { await this.conn.removeOnLogsListener(id); } catch { }
        }
        this.subIds = [];
    }

    private async onLogs(logs: Logs) {
        if (!logs.signature) return;
        if (this.migration) {
            try { await this.migration.onLogs(logs); } catch { }
        }
        try {
            const trades: TradeTick[] = await buildTradesFromSignature(this.conn, logs.signature, this.oracle);
            if (trades.length && this.onTrades) { await this.onTrades(trades); }
            this.rpc.markGood();
        } catch (e) {
            try { await this.failover(); } catch { }
        }
    }

    private async failover(): Promise<void> {
        try {
            for (const id of this.subIds) {
                try { await this.conn.removeOnLogsListener(id); } catch { }
            }
            this.subIds = [];
            this.conn = await this.rpc.rotate();
            this.rpc.markGood();
        } catch { }
    }
}
