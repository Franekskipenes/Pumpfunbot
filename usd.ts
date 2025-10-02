export function deriveUsdPriceFromSol(priceInSol: number, solUsd: number): number {
    return priceInSol * solUsd;
}

export function deriveUsdPriceFromUsdc(priceInUsdc: number): number {
    return priceInUsdc; // 1 USDC ~ $1
}
