import type { Idl } from '@coral-xyz/anchor';

let cached: Idl | undefined;

export async function loadPumpfunIdl(): Promise<Idl> {
    if (cached) return cached;
    // Prefer local path if provided or file exists at project root
    const localPath = process.env.PUMPFUN_IDL_PATH || 'pump.json';
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        if (fs.existsSync(localPath)) {
            const rawLocal = fs.readFileSync(localPath, 'utf8');
            const normalizedLocal = normalizePumpIdlRaw(rawLocal);
            cached = normalizedLocal as Idl;
            return cached;
        }
    } catch { }
    const url = process.env.PUMPFUN_IDL_URL || 'https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch Pump.fun IDL: ${res.status}`);
    const raw = await res.text();
    const normalizedRemote = normalizePumpIdlRaw(raw);
    cached = normalizedRemote as Idl;
    return cached;
}

function normalizePumpIdlRaw(rawText: string): any {
    // Normalize non-standard alias keys if present (e.g., "pubkey" -> "publicKey")
    const normalizedKeyNames = rawText.replace(/"pubkey"/g, '"publicKey"');
    const idlRaw: any = JSON.parse(normalizedKeyNames);
    // Recursively normalize any { defined: { name: "X" } } into { defined: "X" }
    const normalizeDefined = (obj: any): any => {
        if (!obj || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(normalizeDefined);
        const out: any = {};
        for (const [k, v] of Object.entries(obj)) {
            if (k === 'defined' && v && typeof v === 'object' && 'name' in (v as any) && typeof (v as any).name === 'string') {
                out[k] = (v as any).name;
            } else {
                out[k] = normalizeDefined(v);
            }
        }
        return out;
    };
    const idl: any = normalizeDefined(idlRaw);
    // Ensure types array exists
    idl.types = Array.isArray(idl.types) ? idl.types : [];
    const hasType = (name: string) => (idl.types as any[]).some((t: any) => t?.name === name);
    const addOptionType = (name: string, inner: string) => {
        (idl.types as any[]).push({
            name,
            type: {
                kind: 'enum',
                variants: [
                    { name: 'None' },
                    { name: 'Some', fields: [{ type: inner }] },
                ],
            },
        });
    };
    // Patch common missing defined types observed in newer Pump.fun IDLs
    if (!hasType('OptionBool')) addOptionType('OptionBool', 'bool');
    if (!hasType('OptionU64')) addOptionType('OptionU64', 'u64');
    if (!hasType('OptionI64')) addOptionType('OptionI64', 'i64');
    if (!hasType('OptionString')) addOptionType('OptionString', 'string');
    if (!hasType('OptionPubkey')) addOptionType('OptionPubkey', 'publicKey');
    return idl;
}
