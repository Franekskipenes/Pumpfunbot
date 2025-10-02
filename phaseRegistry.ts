export type Phase = 'curve' | 'amm'

class PhaseRegistryImpl {
    private phaseByMint = new Map<string, Phase>()

    get(mint: string): Phase {
        return this.phaseByMint.get(mint) || 'curve'
    }

    set(mint: string, phase: Phase): void {
        this.phaseByMint.set(mint, phase)
    }
}

export const PhaseRegistry = new PhaseRegistryImpl()


