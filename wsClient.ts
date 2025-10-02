import WebSocket from 'ws';

export type JsonRpcRequest = { jsonrpc: '2.0'; id: number; method: string; params?: any };
export type JsonRpcResponse = { jsonrpc: '2.0'; id: number; result?: any; error?: any; method?: string; params?: any };

export interface SubscriptionHandler {
    onNotification: (msg: any) => void;
}

export class JsonRpcWebSocket {
    private ws?: WebSocket;
    private nextId = 1;
    private pending = new Map<number, (res: JsonRpcResponse) => void>();
    private subs = new Map<string, SubscriptionHandler>();
    private isClosing = false;

    constructor(private readonly url: string, private readonly onClose?: () => void) { }

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url);
            this.ws.on('open', () => resolve());
            this.ws.on('message', (data) => this.onMessage(data.toString()));
            this.ws.on('error', (err) => {
                if (this.pending.size === 0) reject(err);
            });
            this.ws.on('close', () => {
                if (!this.isClosing && this.onClose) this.onClose();
            });
        });
    }

    close() {
        this.isClosing = true;
        this.ws?.close();
    }

    private onMessage(raw: string) {
        try {
            const msg: JsonRpcResponse = JSON.parse(raw);
            if (msg.id && this.pending.has(msg.id)) {
                const cb = this.pending.get(msg.id)!;
                this.pending.delete(msg.id);
                cb(msg);
                return;
            }
            if (msg.method === 'logsNotification' || msg.method?.endsWith('Notification')) {
                const subId = msg.params?.subscription?.toString?.() ?? msg.params?.subscription;
                const handler = this.subs.get(String(subId));
                if (handler) handler.onNotification(msg.params?.result ?? msg.params);
            }
        } catch { }
    }

    send<T = any>(method: string, params?: any): Promise<T> {
        const id = this.nextId++;
        const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, (res) => {
                if (res.error) return reject(res.error);
                resolve(res.result as T);
            });
            this.ws?.send(JSON.stringify(req), (err) => {
                if (err) {
                    this.pending.delete(id);
                    reject(err);
                }
            });
        });
    }

    registerSubscription(subId: string, handler: SubscriptionHandler) {
        this.subs.set(subId, handler);
    }

    unregisterSubscription(subId: string) {
        this.subs.delete(subId);
    }
}
