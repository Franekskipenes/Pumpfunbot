export interface HandsConfig {
    modelBaseUrl: string;
    priorityFeeLamports: number;
    rpcHttpUrls: string[];
    rpcWsUrls: string[];
    switchMarginBps: number; // 30-60 bps band; use value provided
    impactCapBps: number;    // 80-120 bps typical
    splitsK: number;         // 2-8
    sliceDelayMs: number;    // delay between slices
    denyMints: Set<string>;
    allowMints: Set<string>;
    preferWsol: boolean;
    twoHopAllowed: boolean;
    dailyLossLimitUsd: number;
    killSwitch: boolean;
}

export function loadConfig(): HandsConfig {
    const modelBaseUrl = process.env.MODEL_BASE_URL || "http://127.0.0.1:8080";
    const priorityFeeLamports = Number(process.env.PRIORITY_FEE_LAMPORTS || 0);
    const rpcHttpUrls = [process.env.SOL_RPC_URL, process.env.SOL_RPC_URL_FAILOVER].filter(Boolean) as string[];
    const rpcWsUrls = [process.env.SOL_WS_URL, process.env.SOL_WS_URL_FAILOVER]
        .map((u) => u || '')
        .filter((u) => u.length > 0) as string[];
    const switchMarginBps = Number(process.env.SWITCH_MARGIN_BPS || 40);
    const impactCapBps = Number(process.env.IMPACT_CAP_BPS || 120);
    const splitsKRaw = Number(process.env.SPLITS_K || 2);
    const splitsK = Math.max(2, Math.min(8, Math.floor(splitsKRaw)));
    const sliceDelayMs = Number(process.env.SLICE_DELAY_MS || 250);
    const denyMints = new Set((process.env.DENY_MINTS || '').split(',').map((s) => s.trim()).filter(Boolean));
    const allowMints = new Set((process.env.ALLOW_MINTS || '').split(',').map((s) => s.trim()).filter(Boolean));
    const preferWsol = (process.env.PREFER_WSOL || 'true').toLowerCase() === 'true';
    const twoHopAllowed = (process.env.TWO_HOP_ALLOWED || 'true').toLowerCase() === 'true';
    const dailyLossLimitUsd = Number(process.env.DAILY_LOSS_LIMIT_USD || 0);
    const killSwitch = (process.env.KILL_SWITCH || 'false').toLowerCase() === 'true';
    return { modelBaseUrl, priorityFeeLamports, rpcHttpUrls, rpcWsUrls, switchMarginBps, impactCapBps, splitsK, sliceDelayMs, denyMints, allowMints, preferWsol, twoHopAllowed, dailyLossLimitUsd, killSwitch };
}
