export interface TradeTick {
    timestamp: number;
    token_mint: string;
    price_usd: number;
    amount_tokens: number;
    is_buy: boolean;
}

export interface Decision {
    token_mint: string;
    action: "buy" | "hold" | "exit";
    size_usd: number;
    z_caer?: number;
    caer?: number;
}

export class ModelClient {
    constructor(private readonly baseUrl: string) { }

    async tick(trades: TradeTick[]): Promise<void> {
        const res = await fetch(`${this.baseUrl}/tick`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trades }),
        });
        if (!res.ok) throw new Error(`tick failed: ${res.status}`);
    }

    async decide(tokenMints: string[]): Promise<Decision[]> {
        const res = await fetch(`${this.baseUrl}/decide`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token_mints: tokenMints }),
        });
        if (!res.ok) throw new Error(`decide failed: ${res.status}`);
        const json = await res.json();
        return json.decisions as Decision[];
    }

    async phase(tokenMint: string, phase: "curve" | "amm"): Promise<void> {
        const res = await fetch(`${this.baseUrl}/phase`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token_mint: tokenMint, phase }),
        });
        if (!res.ok) throw new Error(`phase failed: ${res.status}`);
    }
}
