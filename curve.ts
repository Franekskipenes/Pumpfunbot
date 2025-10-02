import { Connection, PublicKey, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstructionCtorFields, AccountMeta } from '@solana/web3.js';
import { Idl, BorshCoder } from '@coral-xyz/anchor';
import BN from 'bn.js';
import { PUMPFUN_PROGRAM_ID } from '../constants';
import { loadPumpfunIdl } from '../pumpfunIdl';
import { SwapParams, withPriorityFee, buildV0Tx, BuiltTx } from './builder';
import { getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';

// Cache Pump.fun feeRecipient derived from Global PDA
let _cachedFeeRecipient: PublicKey | undefined;
let _cachedAtMs = 0;
const _REFRESH_MS = Number(process.env.PUMPFUN_FEE_REFRESH_MS || 300_000); // 5 minutes default

export async function prefetchPumpfunFeeRecipient(conn: Connection): Promise<void> {
    try {
        await getGlobalFeeRecipientCached(conn, new PublicKey(PUMPFUN_PROGRAM_ID));
    } catch { }
}

export function getCachedPumpfunFeeRecipient(): PublicKey | undefined {
    return _cachedFeeRecipient;
}

// Per-mint creator_vault cache (creator_vault depends on BondingCurve.creator)
const _creatorVaultByMint: Map<string, PublicKey> = new Map();
const _creatorVaultAtMsByMint: Map<string, number> = new Map();
const _CREATOR_VAULT_REFRESH_MS = Number(process.env.PUMPFUN_CREATOR_VAULT_REFRESH_MS || 300_000);
const CREATOR_VAULT_STORE_PATH = process.env.CREATOR_VAULT_STORE_PATH || 'creator_vault_cache.json';
let _storeLoaded = false;
const dbgLog = (m: string) => { try { if ((process.env.DEBUG_PUMPFUN || '').toLowerCase() === 'true') console.warn(`[pumpfun] ${m}`); } catch { } };

async function ensureCreatorVaultStoreLoaded(): Promise<void> {
    if (_storeLoaded) return;
    try {
        const text = await fs.readFile(CREATOR_VAULT_STORE_PATH, 'utf8');
        const obj = JSON.parse(text || '{}') as Record<string, string>;
        for (const [mint, vault] of Object.entries(obj)) {
            try {
                const pk = new PublicKey(vault);
                _creatorVaultByMint.set(mint, pk);
                _creatorVaultAtMsByMint.set(mint, Date.now());
                dbgLog(`store load creator_vault ${mint} => ${pk.toBase58()}`);
            } catch { }
        }
    } catch { /* file may not exist */ }
    _storeLoaded = true;
}

async function persistCreatorVault(mint: PublicKey, vault: PublicKey): Promise<void> {
    try {
        await ensureCreatorVaultStoreLoaded();
        // Load current
        let obj: Record<string, string> = {};
        try {
            const text = await fs.readFile(CREATOR_VAULT_STORE_PATH, 'utf8');
            obj = JSON.parse(text || '{}');
        } catch { }
        obj[mint.toBase58()] = vault.toBase58();
        await fs.writeFile(CREATOR_VAULT_STORE_PATH, JSON.stringify(obj, null, 2), 'utf8');
        dbgLog(`store write creator_vault ${mint.toBase58()} => ${vault.toBase58()}`);
    } catch { }
}

export async function prefetchPumpfunCreatorVault(conn: Connection, mint: PublicKey, persist: boolean = false): Promise<boolean> {
    try {
        const pk = await getCreatorVaultForMint(conn, new PublicKey(PUMPFUN_PROGRAM_ID), mint, persist);
        return !!pk;
    } catch {
        return false;
    }
}

export function getCachedPumpfunCreatorVault(mint: PublicKey): PublicKey | undefined {
    return _creatorVaultByMint.get(mint.toBase58());
}

export async function buildCurveBuyTx(conn: Connection, params: SwapParams): Promise<BuiltTx> {
    const idl: Idl = await loadPumpfunIdl();
    const ixs: TransactionInstruction[] = [];
    // Derive accounts
    const mint = params.outputMint; // buying token -> output is token mint
    const ata = getAssociatedTokenAddressSync(mint, params.payer, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const ataInfo = await conn.getAccountInfo(ata);
    if (!ataInfo) {
        ixs.push(createAssociatedTokenAccountInstruction(params.payer, ata, params.payer, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    }
    // Fallback: encode minOut as zero to avoid IDL/account layout dependency
    const dx = new BN(params.amountInAtoms.toString()); // lamports in
    const minOut = new BN(0);

    // Build buy instruction from IDL
    const buyIx = (idl.instructions || []).find((ix) => ix.name === 'buy');
    if (!buyIx) throw new Error('Pump.fun buy instruction not found in IDL');
    const argBytes: Buffer[] = [];
    for (const a of buyIx.args || []) {
        const nm = a.name.toLowerCase();
        if (nm.includes('min') && nm.includes('out')) {
            argBytes.push(encodeInteger(minOut, a.type));
        } else if (nm.includes('amount') || nm.includes('lamport') || nm.includes('sol')) {
            argBytes.push(encodeInteger(dx, a.type));
        } else {
            argBytes.push(encodeDefaultForType(a.type));
        }
    }
    const accounts: Record<string, PublicKey> = await resolveCurveAccounts(conn, buyIx.accounts as any[], params.payer, mint, ata);
    // Force associated_user to be the payer's ATA for this mint
    accounts['associated_user'] = ata;
    // Ensure associated_bonding_curve ATA exists (ATA for owner=bonding_curve)
    try {
        const abc = accounts['associated_bonding_curve'];
        const bc = accounts['bonding_curve'];
        if (abc && bc) {
            const abcInfo = await conn.getAccountInfo(abc);
            if (!abcInfo) {
                ixs.push(createAssociatedTokenAccountInstruction(params.payer, abc, bc, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
            }
        }
    } catch { }
    const disc = anchorDiscriminator(buyIx.name);
    const data = Buffer.concat([disc, ...argBytes]);
    const keys: AccountMeta[] = (buyIx.accounts as any[]).map((a: any) => ({ pubkey: accounts[a.name], isSigner: !!a.isSigner, isWritable: !!a.isMut }));
    ixs.push(new TransactionInstruction({ programId: new PublicKey(PUMPFUN_PROGRAM_ID), keys, data }));

    const ixsWithFee = await withPriorityFee(ixs, params.priorityFeeLamports);
    const tx = await buildV0Tx(conn, params.payer, ixsWithFee);
    return { transaction: tx };
}

export async function buildCurveSellTx(conn: Connection, params: SwapParams): Promise<BuiltTx> {
    const idl: Idl = await loadPumpfunIdl();
    const ixs: TransactionInstruction[] = [];
    const mint = params.inputMint; // selling token
    const ata = getAssociatedTokenAddressSync(mint, params.payer, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const ataInfo = await conn.getAccountInfo(ata);
    if (!ataInfo) {
        // must have ATA with balance to sell; just ensure existence
        ixs.push(createAssociatedTokenAccountInstruction(params.payer, ata, params.payer, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    }
    // Fallback: minOut = 0 to avoid layout dependence
    const dy = new BN(params.amountInAtoms.toString()); // tokens in atoms
    const minOut = new BN(0);

    const sellIx = (idl.instructions || []).find((ix) => ix.name === 'sell');
    if (!sellIx) throw new Error('Pump.fun sell instruction not found in IDL');
    const sellArgBytes: Buffer[] = [];
    for (const a of sellIx.args || []) {
        const nm = a.name.toLowerCase();
        if (nm.includes('min') && nm.includes('out')) {
            sellArgBytes.push(encodeInteger(minOut, a.type));
        } else if (nm.includes('amount') || nm.includes('tokens') || nm.includes('in')) {
            sellArgBytes.push(encodeInteger(dy, a.type));
        } else {
            sellArgBytes.push(encodeDefaultForType(a.type));
        }
    }
    const accounts: Record<string, PublicKey> = await resolveCurveAccounts(conn, sellIx.accounts as any[], params.payer, mint, ata);
    accounts['associated_user'] = ata;
    // Ensure associated_bonding_curve ATA exists for sell path as well
    try {
        const abc = accounts['associated_bonding_curve'];
        const bc = accounts['bonding_curve'];
        if (abc && bc) {
            const abcInfo = await conn.getAccountInfo(abc);
            if (!abcInfo) {
                ixs.push(createAssociatedTokenAccountInstruction(params.payer, abc, bc, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
            }
        }
    } catch { }
    const sdisc = anchorDiscriminator(sellIx.name);
    const data = Buffer.concat([sdisc, ...sellArgBytes]);
    const keys: AccountMeta[] = (sellIx.accounts as any[]).map((a: any) => ({ pubkey: accounts[a.name], isSigner: !!a.isSigner, isWritable: !!a.isMut }));
    ixs.push(new TransactionInstruction({ programId: new PublicKey(PUMPFUN_PROGRAM_ID), keys, data }));

    const ixsWithFee = await withPriorityFee(ixs, params.priorityFeeLamports);
    const tx = await buildV0Tx(conn, params.payer, ixsWithFee);
    return { transaction: tx };
}

async function resolveCurveAccounts(
    conn: Connection,
    accountsSpec: any[],
    payer: PublicKey,
    mint: PublicKey,
    userAta: PublicKey,
): Promise<Record<string, PublicKey>> {
    const programId = new PublicKey(PUMPFUN_PROGRAM_ID);
    const map: Record<string, PublicKey> = {};
    for (const acc of accountsSpec) {
        const name: string = acc.name;
        const key = name.toLowerCase();
        // If IDL specifies a fixed address, trust it
        if (acc.address) {
            try { map[name] = new PublicKey(acc.address); continue; } catch { }
        }
        if (key.includes('user') || key.includes('authority') || key === 'owner') {
            map[name] = payer;
            continue;
        }
        if (key === 'mint') {
            map[name] = mint;
            continue;
        }
        if (key === 'user' || key === 'payer' || key === 'authority') {
            map[name] = payer;
            continue;
        }
        if (key === 'associated_user') {
            // ATA(user, mint)
            const ataUser = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
            map[name] = ataUser;
            continue;
        }
        if (key.includes('associated') && key.includes('token')) {
            map[name] = userAta;
            continue;
        }
        if (key === 'systemprogram' || key.includes('system')) {
            map[name] = SystemProgram.programId;
            continue;
        }
        if (key === 'program' || key.endsWith('_program') || key.endsWith('program')) {
            map[name] = programId;
            continue;
        }
        if (key.includes('tokenprogram')) {
            map[name] = TOKEN_PROGRAM_ID;
            continue;
        }
        if (key.includes('associatedtokenprogram')) {
            map[name] = ASSOCIATED_TOKEN_PROGRAM_ID;
            continue;
        }
        if (key === 'rent' || key.includes('rent')) {
            map[name] = SYSVAR_RENT_PUBKEY;
            continue;
        }
        // Try PDA from IDL seeds
        const pda = acc.pda;
        if (pda?.seeds) {
            const seeds: Buffer[] = [];
            let pdaProgramId = programId;
            try {
                const pg = (pda as any).program;
                if (pg?.kind === 'const' && pg.value) {
                    if (typeof pg.value === 'string') {
                        pdaProgramId = new PublicKey(pg.value);
                    } else if (Array.isArray(pg.value)) {
                        pdaProgramId = new PublicKey(Uint8Array.from(pg.value));
                    }
                } else if (pg?.kind === 'account' && typeof pg.path === 'string') {
                    const path = String(pg.path).toLowerCase();
                    if (path.includes('token_2022')) {
                        // token-2022 program id
                        pdaProgramId = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
                    } else if (path.includes('token')) {
                        pdaProgramId = TOKEN_PROGRAM_ID;
                    }
                }
            } catch { }
            for (const s of pda.seeds) {
                if (s.kind === 'const') {
                    const v: any = (s as any).value;
                    if (typeof v === 'string') {
                        seeds.push(Buffer.from(v));
                    } else if (Array.isArray(v)) {
                        try { seeds.push(Buffer.from(Uint8Array.from(v))); } catch { }
                    }
                } else if (s.kind === 'account' && typeof s.path === 'string') {
                    const pathLc = s.path.toLowerCase();
                    if (pathLc.includes('mint')) seeds.push(mint.toBuffer());
                    if (pathLc.includes('authority') || pathLc.includes('user')) seeds.push(payer.toBuffer());
                    // If seed references bonding_curve PDA itself
                    if (pathLc === 'bonding_curve' || pathLc.includes('bonding_curve.')) {
                        try {
                            let bcPk = map['bonding_curve'];
                            if (!bcPk) {
                                const [pdaKey] = await PublicKey.findProgramAddress([Buffer.from('bonding-curve'), mint.toBuffer()], programId);
                                bcPk = pdaKey;
                            }
                            seeds.push(bcPk.toBuffer());
                        } catch { }
                    }
                    // If seed references token_program, push SPL Token program id as seed
                    if (pathLc.includes('token_program')) {
                        try { seeds.push(TOKEN_PROGRAM_ID.toBuffer()); } catch { }
                    }
                    // Handle nested paths like 'bonding_curve.creator'
                    try {
                        const p = pathLc;
                        if (p.includes('bonding_curve') && p.includes('creator')) {
                            // Decode BondingCurve to extract creator
                            let bcPk = map['bonding_curve'];
                            if (!bcPk) {
                                const [pdaKey] = await PublicKey.findProgramAddress([Buffer.from('bonding-curve'), mint.toBuffer()], programId);
                                bcPk = pdaKey;
                            }
                            const info = await conn.getAccountInfo(bcPk);
                            if (info?.data) {
                                try {
                                    const idl = await loadPumpfunIdl();
                                    const coder = new BorshCoder(idl as any);
                                    const decoded: any = coder.accounts.decode('BondingCurve', info.data as Buffer);
                                    const creatorAny = decoded?.creator;
                                    if (creatorAny) {
                                        const creatorPk = creatorAny instanceof PublicKey ? creatorAny : new PublicKey(creatorAny);
                                        seeds.push(creatorPk.toBuffer());
                                    }
                                } catch { }
                            }
                        }
                    } catch { }
                }
            }
            if (seeds.length) {
                const [pdaKey] = await PublicKey.findProgramAddress(seeds, pdaProgramId);
                map[name] = pdaKey;
                continue;
            }
        }
        // Fallback for curve/bonding PDA
        if (key.includes('bond') || key.includes('curve')) {
            const [pdaKey] = await PublicKey.findProgramAddress([Buffer.from('bonding-curve'), mint.toBuffer()], programId);
            map[name] = pdaKey;
            continue;
        }
        // Explicit derivation for creator_vault
        if (key.includes('creator') && key.includes('vault')) {
            // Env override
            const envCv = process.env.PUMPFUN_CREATOR_VAULT;
            if (envCv) {
                try { map[name] = new PublicKey(envCv); continue; } catch { }
            }
            // Cached or derive using BondingCurve.creator
            const cached = _creatorVaultByMint.get(mint.toBase58());
            const lastMs = _creatorVaultAtMsByMint.get(mint.toBase58()) || 0;
            if (cached && (Date.now() - lastMs) < _CREATOR_VAULT_REFRESH_MS) {
                map[name] = cached; continue;
            }
            try {
                const cv = await getCreatorVaultForMint(conn, programId, mint);
                if (cv) { map[name] = cv; continue; }
            } catch { }
        }
        // Explicit resolution for fee_config via Global account
        if (key.includes('fee') && key.includes('config')) {
            try {
                const cfgPk = await getGlobalFeeConfigPk(conn, programId);
                if (cfgPk) { map[name] = cfgPk; continue; }
            } catch { }
        }
        // Fee recipient from global state (strict: only recipient/receiver fields)
        if (key.includes('fee') && (key.includes('recipient') || key.includes('receiver'))) {
            try {
                const feePk = await getGlobalFeeRecipientCached(conn, programId);
                if (feePk) { map[name] = feePk; continue; }
            } catch { }
        }
        // Fallback for global/program state PDA commonly used by Pump.fun
        if (key === 'global') {
            try {
                const [pdaKey] = await PublicKey.findProgramAddress([Buffer.from('global')], programId);
                map[name] = pdaKey;
                continue;
            } catch { }
        }
        // Anchor event authority (best-effort)
        if (key.includes('event') && key.includes('authorit')) {
            try {
                const [pdaKey] = await PublicKey.findProgramAddress([Buffer.from('event_authority')], programId);
                map[name] = pdaKey;
                continue;
            } catch { }
        }
        throw new Error(`Unable to resolve account ${name}`);
    }
    return map;
}

function anchorDiscriminator(ixName: string): Buffer {
    const preimage = Buffer.from('global:' + ixName);
    const h = createHash('sha256').update(preimage).digest();
    return h.subarray(0, 8);
}

function encodeInteger(value: BN, typeSpec: any): Buffer {
    const t = normalizeTypeName(typeSpec);
    const width = t === 'u128' || t === 'i128' ? 16 : t === 'u64' || t === 'i64' ? 8 : t === 'u32' || t === 'i32' ? 4 : t === 'u16' || t === 'i16' ? 2 : 1;
    const signed = /^i/.test(t);
    const v = value instanceof BN ? value : new BN(value as any);
    return v.toArrayLike(Buffer, 'le', width);
}

function encodeDefaultForType(typeSpec: any): Buffer {
    // Handle primitives
    if (!typeSpec) return Buffer.alloc(0);
    if (typeof typeSpec === 'string') {
        switch (typeSpec) {
            case 'bool': return Buffer.from([0]);
            case 'u8': case 'i8': return Buffer.alloc(1, 0);
            case 'u16': case 'i16': return Buffer.alloc(2, 0);
            case 'u32': case 'i32': return Buffer.alloc(4, 0);
            case 'u64': case 'i64': return Buffer.alloc(8, 0);
            case 'u128': case 'i128': return Buffer.alloc(16, 0);
            case 'publicKey': return Buffer.alloc(32, 0);
            case 'string': case 'bytes': return Buffer.concat([u32le(0)]);
            default: return Buffer.alloc(0);
        }
    }
    if (typeof typeSpec === 'object') {
        if ('option' in typeSpec) {
            return Buffer.from([0]); // None
        }
        if ('vec' in typeSpec) {
            return u32le(0); // empty vector
        }
        if ('array' in typeSpec) {
            const [elemType, len] = (typeSpec as any).array as [any, number];
            const parts: Buffer[] = [];
            for (let i = 0; i < (len || 0); i++) parts.push(encodeDefaultForType(elemType));
            return Buffer.concat(parts);
        }
        if ('defined' in typeSpec) {
            const name = String((typeSpec as any).defined || '').toLowerCase();
            if (name.startsWith('option')) return Buffer.from([0]);
            // Unknown defined type: best-effort 0
            return Buffer.alloc(0);
        }
    }
    return Buffer.alloc(0);
}

function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

function normalizeTypeName(t: any): string {
    if (!t) return 'u64';
    if (typeof t === 'string') return t;
    if (typeof t === 'object' && 'defined' in t && typeof (t as any).defined === 'string') return (t as any).defined;
    return 'u64';
}

async function getGlobalFeeRecipientCached(conn: Connection, programId: PublicKey): Promise<PublicKey | undefined> {
    try {
        const dbg = (m: string) => { try { if ((process.env.DEBUG_PUMPFUN || '').toLowerCase() === 'true') console.warn(`[pumpfun] ${m}`); } catch { } };
        // Allow env override to avoid IDL/account layout dependency or when docs/IDL change
        const envFee = process.env.PUMPFUN_FEE_RECIPIENT;
        if (envFee) {
            try {
                const pk = new PublicKey(envFee);
                _cachedFeeRecipient = pk;
                _cachedAtMs = Date.now();
                dbg(`using env PUMPFUN_FEE_RECIPIENT=${pk.toBase58()}`);
                return pk;
            } catch { /* fallthrough */ }
        }
        // Use cache if fresh
        if (_cachedFeeRecipient && (Date.now() - _cachedAtMs) < _REFRESH_MS) {
            dbg(`cache hit feeRecipient=${_cachedFeeRecipient.toBase58()}`);
            return _cachedFeeRecipient;
        }
        const idl = await loadPumpfunIdl();
        const coder = new BorshCoder(idl as any);
        const [pda] = await PublicKey.findProgramAddress([Buffer.from('global')], programId);
        const info = await conn.getAccountInfo(pda, 'confirmed');
        if (!info?.data) { dbg(`Global PDA ${pda.toBase58()} not found`); return undefined; }
        for (const def of ((idl as any).accounts || []) as any[]) {
            try {
                const decoded: any = coder.accounts.decode(def.name, info.data);
                const pk = extractFeePk(decoded);
                if (pk) {
                    _cachedFeeRecipient = pk;
                    _cachedAtMs = Date.now();
                    dbg(`decoded fee_recipient via IDL=${pk.toBase58()}`);
                    return pk;
                }
            } catch { }
        }
        // Raw fallback: parse known Global layout to extract fee_recipient
        try {
            const buf = info.data as Buffer;
            if (buf.length >= 8 + 1 + 32 + 32) {
                // [8] discriminator, [1] initialized bool, [32] authority, [32] fee_recipient
                const offset = 8 + 1 + 32;
                const slice = buf.subarray(offset, offset + 32);
                const pk = new PublicKey(slice);
                _cachedFeeRecipient = pk;
                _cachedAtMs = Date.now();
                dbg(`decoded fee_recipient via raw layout=${pk.toBase58()}`);
                return pk;
            }
            dbg(`raw fallback failed: dataLen=${buf.length}`);
        } catch { }
    } catch { }
    return undefined;
}

// Derive the new fee_config PDA for Pump.fun using IDL-provided seeds
async function getGlobalFeeConfigPk(conn: Connection, programId: PublicKey): Promise<PublicKey | undefined> {
    try {
        const idl = await loadPumpfunIdl();
        // The buy/sell accounts in current IDL specify fee_config as PDA under fee_program with seeds ["fee_config", <program id as bytes>]
        // Find the fee_program id either from IDL or constants
        let feeProgramId: PublicKey | undefined;
        try {
            // Prefer explicit address in the IDL accounts for buy
            const buy = (idl as any).instructions?.find((ix: any) => ix?.name === 'buy');
            const feeProgAcc = buy?.accounts?.find((a: any) => a?.name === 'fee_program');
            if (feeProgAcc?.address) {
                feeProgramId = new PublicKey(feeProgAcc.address);
            }
        } catch { }
        if (!feeProgramId) {
            // Fallback to known program id from bundled pump.json if present
            try { feeProgramId = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'); } catch { }
        }
        if (!feeProgramId) return undefined;
        const seedA = Buffer.from('fee_config');
        // Some IDLs encode the second seed as a 32-byte constant. Use the Pump.fun programId as a stable seed fallback.
        const seedB = programId.toBuffer();
        const [pda] = await PublicKey.findProgramAddress([seedA, seedB], feeProgramId);
        return pda;
    } catch {
        return undefined;
    }
}

async function getCreatorVaultForMint(conn: Connection, programId: PublicKey, mint: PublicKey, persist: boolean = false): Promise<PublicKey | undefined> {
    try {
        await ensureCreatorVaultStoreLoaded();
        const envCv = process.env.PUMPFUN_CREATOR_VAULT;
        if (envCv) {
            try {
                const pk = new PublicKey(envCv);
                _creatorVaultByMint.set(mint.toBase58(), pk);
                _creatorVaultAtMsByMint.set(mint.toBase58(), Date.now());
                if (persist) { await persistCreatorVault(mint, pk); }
                return pk;
            } catch { }
        }
        // If cached and fresh
        const cached = _creatorVaultByMint.get(mint.toBase58());
        const lastMs = _creatorVaultAtMsByMint.get(mint.toBase58()) || 0;
        if (cached && (Date.now() - lastMs) < _CREATOR_VAULT_REFRESH_MS) return cached;
        // Try on-disk store stale or not yet cached
        const stored = _creatorVaultByMint.get(mint.toBase58());
        if (stored) { dbgLog(`store hit creator_vault ${mint.toBase58()} => ${stored.toBase58()}`); return stored; }
        // Read BondingCurve and derive creator_vault
        const [bcPda] = await PublicKey.findProgramAddress([Buffer.from('bonding-curve'), mint.toBuffer()], programId);
        const info = await conn.getAccountInfo(bcPda, 'confirmed');
        if (!info?.data) { dbgLog(`no BondingCurve for ${mint.toBase58()}`); return undefined; }
        try {
            const idl = await loadPumpfunIdl();
            const coder = new BorshCoder(idl as any);
            const decoded: any = coder.accounts.decode('BondingCurve', info.data as Buffer);
            const creatorAny = decoded?.creator;
            const creatorPk = creatorAny instanceof PublicKey ? creatorAny : new PublicKey(creatorAny);
            const [cvPda] = await PublicKey.findProgramAddress([Buffer.from('creator-vault'), creatorPk.toBuffer()], programId);
            _creatorVaultByMint.set(mint.toBase58(), cvPda);
            _creatorVaultAtMsByMint.set(mint.toBase58(), Date.now());
            dbgLog(`derived creator_vault ${mint.toBase58()} => ${cvPda.toBase58()}`);
            if (persist) { await persistCreatorVault(mint, cvPda); }
            return cvPda;
        } catch {
            // Raw fallback: attempt to read creator from tail of BondingCurve when IDL decode fails
            try {
                const buf = info.data as Buffer;
                if (buf.length >= 8 + 5 * 8 + 1 + 32) {
                    // creator is last field in BondingCurve schema
                    const creatorSlice = buf.subarray(buf.length - 32);
                    const creatorPk = new PublicKey(creatorSlice);
                    const [cvPda] = await PublicKey.findProgramAddress([Buffer.from('creator-vault'), creatorPk.toBuffer()], programId);
                    _creatorVaultByMint.set(mint.toBase58(), cvPda);
                    _creatorVaultAtMsByMint.set(mint.toBase58(), Date.now());
                    dbgLog(`raw derived creator_vault ${mint.toBase58()} => ${cvPda.toBase58()}`);
                    if (persist) { await persistCreatorVault(mint, cvPda); }
                    return cvPda;
                } else {
                    dbgLog(`bonding curve data too short for raw fallback: len=${buf.length}`);
                }
            } catch { }
        }
    } catch { }
    return undefined;
}

function extractFeePk(obj: any): PublicKey | undefined {
    if (!obj || typeof obj !== 'object') return undefined;
    const keys = ['feeRecipient', 'fee_recipient', 'feeReceiver', 'fee_receiver', 'feeVault', 'fee_vault', 'feeDestination', 'fee_dest'];
    for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
            const v: any = obj[k];
            try {
                if (v instanceof PublicKey) return v;
                if (typeof v === 'string') return new PublicKey(v);
                if (Array.isArray(v) && v.length === 32) return new PublicKey(Uint8Array.from(v));
                if (v && typeof v.toBase58 === 'function') return new PublicKey(v.toBase58());
                if (v && v._bn) return new PublicKey(v);
                if (v && (v as any).data && (v as any).data.length === 32) return new PublicKey((v as any).data);
            } catch { }
        }
    }
    // Handle array of recipients
    if (Object.prototype.hasOwnProperty.call(obj, 'fee_recipients')) {
        try {
            const arr: any = (obj as any)['fee_recipients'];
            if (Array.isArray(arr)) {
                for (const elem of arr) {
                    try {
                        if (elem instanceof PublicKey) return elem;
                        if (typeof elem === 'string') return new PublicKey(elem);
                        if (Array.isArray(elem) && elem.length === 32) return new PublicKey(Uint8Array.from(elem));
                        if (elem && typeof elem.toBase58 === 'function') return new PublicKey(elem.toBase58());
                        if (elem && elem._bn) return new PublicKey(elem);
                    } catch { }
                }
            }
        } catch { }
    }
    for (const val of Object.values(obj)) {
        const found = extractFeePk(val);
        if (found) return found;
    }
    return undefined;
}
