import { Connection } from '@solana/web3.js'

export class RpcManager {
    private httpUrls: string[]
    private wsUrls: string[]
    private idx = 0
    private backoffMs = 500
    private conn?: Connection

    constructor(httpUrls: string[], wsUrls: string[]) {
        this.httpUrls = (httpUrls || []).filter(Boolean)
        this.wsUrls = (wsUrls || []).filter(Boolean)
    }

    getConnection(): Connection {
        if (!this.conn) this.conn = this.buildConnection()
        return this.conn
    }

    async rotate(): Promise<Connection> {
        this.idx = (this.idx + 1) % Math.max(1, this.httpUrls.length)
        await new Promise(r => setTimeout(r, this.backoffMs))
        this.backoffMs = Math.min(this.backoffMs * 2, 10_000)
        this.conn = this.buildConnection()
        return this.conn
    }

    markGood(): void {
        this.backoffMs = 500
    }

    private buildConnection(): Connection {
        const http = this.httpUrls[this.idx] || 'https://api.mainnet-beta.solana.com'
        const ws = this.wsUrls[this.idx] || undefined
        return new Connection(http, { commitment: 'confirmed', wsEndpoint: ws })
    }
}


