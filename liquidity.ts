export function estimateExitImpactBpsFromVolumeUSD(notionalUsd: number, windowVolumeUsd: number): number {
    if (windowVolumeUsd <= 0) return 10_000;
    const fraction = Math.min(Math.max(notionalUsd / Math.max(windowVolumeUsd, 1), 0), 10);
    return 10000 * Math.sqrt(fraction) * 0.25;
}

export function ammSlippageBps(inputAmount: number, reserveIn: number, reserveOut: number): number {
    if (reserveIn <= 0 || reserveOut <= 0) return 10_000;
    const newIn = reserveIn + inputAmount;
    const newOut = (reserveIn * reserveOut) / newIn;
    const outAmount = reserveOut - newOut;
    const priceBefore = reserveOut / reserveIn;
    const priceAfter = (reserveOut - outAmount) / (reserveIn + inputAmount);
    return Math.abs(priceAfter - priceBefore) / priceBefore * 10_000;
}
