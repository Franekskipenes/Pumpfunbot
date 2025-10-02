import { TradeTick } from './modelClient'

type Tick = {
    timestamp: number
    price_usd: number
    volume_usd: number
    buy_volume_usd: number
    sell_volume_usd: number
}

export class RollingWindows {
    private buffers: Map<string, Map<number, Tick[]>> = new Map()
    private lastPrice: Map<string, number> = new Map()
    private lastTs: Map<string, number> = new Map()
    constructor(public windows: number[]) { }

    update(t: TradeTick) {
        const vol = Math.abs(t.price_usd * t.amount_tokens)
        const tick: Tick = {
            timestamp: t.timestamp,
            price_usd: t.price_usd,
            volume_usd: vol,
            buy_volume_usd: t.is_buy ? vol : 0,
            sell_volume_usd: t.is_buy ? 0 : vol,
        }
        if (!this.buffers.has(t.token_mint)) this.buffers.set(t.token_mint, new Map())
        const m = this.buffers.get(t.token_mint)!
        for (const w of this.windows) {
            if (!m.has(w)) m.set(w, [])
            const arr = m.get(w)!
            arr.push(tick)
            this.trim(arr, w, t.timestamp)
        }
        this.lastPrice.set(t.token_mint, t.price_usd)
        this.lastTs.set(t.token_mint, t.timestamp)
    }

    private trim(arr: Tick[], w: number, now: number) {
        while (arr.length && now - arr[0].timestamp > w) arr.shift()
    }

    midprice(mint: string): number | undefined { return this.lastPrice.get(mint) }
    lastAgeSeconds(mint: string): number | undefined {
        const ts = this.lastTs.get(mint)
        if (ts === undefined) return undefined
        return Date.now() / 1000 - ts
    }
    tradeCount(mint: string, w: number): number { return this.buf(mint, w).length }
    volumeUsd(mint: string, w: number): number { return this.buf(mint, w).reduce((s, t) => s + t.volume_usd, 0) }
    buySell(mint: string, w: number): { buy: number; sell: number } {
        const arr = this.buf(mint, w)
        return { buy: arr.reduce((s, t) => s + t.buy_volume_usd, 0), sell: arr.reduce((s, t) => s + t.sell_volume_usd, 0) }
    }
    logReturn(mint: string, w: number): number | undefined {
        const arr = this.buf(mint, w)
        if (arr.length < 2) return undefined
        const p0 = arr[0].price_usd, pt = arr[arr.length - 1].price_usd
        if (p0 <= 0 || pt <= 0) return undefined
        return Math.log(pt / p0)
    }
    private buf(mint: string, w: number): Tick[] {
        const m = this.buffers.get(mint)
        if (!m) return []
        return m.get(w) || []
    }
}


