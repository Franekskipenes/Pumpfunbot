export interface BuiltTx {
    id: string;
    slots: number;
}

export async function buildAndSimulateSwap(params: {
    tokenMint: string;
    action: "buy" | "exit";
    sizeUsd: number;
    slippageBps: number;
    priorityFeeLamports: number;
}): Promise<BuiltTx> {
    // TODO: integrate PumpSwap/Raydium + Jito bundles
    return { id: `${params.tokenMint}-${Date.now()}`, slots: 1 };
}
