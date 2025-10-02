import { Connection, PublicKey } from '@solana/web3.js';
import { PythHttpClient, getPythProgramKeyForCluster } from '@pythnetwork/client';

export class SolPriceOracle {
    private last: number;
    private conn: Connection;
    private feedSymbol: string;
    private cluster: 'mainnet-beta' | 'devnet' = (process.env.SOL_CLUSTER as any) || 'mainnet-beta';

    constructor() {
        this.last = Number(process.env.SOL_USD_HINT || 150);
        const rpcUrl = process.env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com';
        this.conn = new Connection(rpcUrl, 'confirmed');
        this.feedSymbol = process.env.PYTH_SOL_SYMBOL || 'Crypto.SOL/USD';
    }

    async start(): Promise<void> {
        try {
            const pythPublicKey = getPythProgramKeyForCluster(this.cluster);
            const pythClient = new PythHttpClient(this.conn, pythPublicKey);
            // Initial fetch and then poll every few seconds; WS price service can be added later
            const update = async () => {
                try {
                    const data = await pythClient.getData();
                    const priceInfo = data.products.find((p) => p.symbol === this.feedSymbol);
                    if (priceInfo) {
                        const price = data.getPrice(priceInfo.symbol);
                        if (price?.price && isFinite(price.price)) {
                            this.last = Number(price.price);
                        }
                    }
                } catch { }
            };
            await update();
            setInterval(update, 5_000);
        } catch {
            // keep last hint
        }
    }

    get(): number {
        return this.last;
    }
}
