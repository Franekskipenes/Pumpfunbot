import { RollingWindows } from './rolling'

function median(values: number[]): number { const a = [...values].sort((x, y) => x - y); const n = a.length; return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2 }
function mad(values: number[], m: number): number { const d = values.map(v => Math.abs(v - m)); return median(d) }

export class AlphaEngine {
    constructor(private rolling: RollingWindows, private windows: number[]) { }

    computeCaerAndZ(mints: string[], w: number): { caer: Record<string, number>, z: Record<string, number> } {
        const rets: Record<string, number> = {}
        for (const m of mints) {
            const r = this.rolling.logReturn(m, w)
            if (r !== undefined) rets[m] = r
        }
        const vals = Object.values(rets)
        if (vals.length < 2) return { caer: {}, z: {} }
        const m0 = median(vals)
        const dev = mad(vals, m0)
        const lower = m0 - 3 * dev, upper = m0 + 3 * dev
        const wins: Record<string, number> = {}
        for (const [k, v] of Object.entries(rets)) wins[k] = Math.max(lower, Math.min(upper, v))
        const b = median(Object.values(wins))
        const caer: Record<string, number> = {}
        for (const [k, v] of Object.entries(wins)) caer[k] = v - b
        const e = Object.values(caer)
        const m1 = median(e.map(Math.abs))
        const scale = 1.4826 * (m1 || 1e-8)
        const z: Record<string, number> = {}
        for (const [k, v] of Object.entries(caer)) z[k] = v / scale
        return { caer, z }
    }
}


