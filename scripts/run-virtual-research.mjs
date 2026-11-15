#!/usr/bin/env node
/** Synthetic demo only. The legacy observed entry point is explicitly disabled. */
import { join } from 'node:path';
import { runResearchCycle, syntheticResearchRequest } from './lib/virtual-research-cycle.mjs';
import { createSyntheticFileStore } from './lib/research-reservations.mjs';
const [input, stateDir, ledgerConfig, ...extra] = process.argv.slice(2);
if (!input || !stateDir || extra.length || (input === '--demo' && ledgerConfig)) {
  console.error('Usage: node scripts/run-virtual-research.mjs --demo STATE_DIRECTORY (observed execution is disabled)'); process.exitCode = 2;
} else {
  try {
    // Refuse before reading request/config files or credentials, making network
    // calls, or creating state. A private ledger is not an activation certificate.
    if (input !== '--demo') throw new Error('Observed research disabled: historical reconciliation, independent witness and protected runner are not verified. Only --demo is available.');
    const reservationStore = createSyntheticFileStore(join(stateDir, 'synthetic-authority'));
    const result = await runResearchCycle({ request: syntheticResearchRequest(), stateDir, reservationStore });
    console.log(JSON.stringify(result, null, 2));
    // A successful research run is still blocked, never a promotion certificate.
    process.exitCode = result.eligible ? 0 : 3;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
