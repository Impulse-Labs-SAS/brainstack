// Build script for the BrainStack skill package.
// Reads INSTRUCTIONS.md and runs each adapter to generate dist/<client>/...
// Real implementation lands in Fase 5.

export async function build(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[skill] build placeholder — Fase 5');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void build();
}
