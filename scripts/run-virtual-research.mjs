#!/usr/bin/env node
/** Virtual only. --demo is isolated/synthetic; observed research requires a shared ledger. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runResearchCycle, syntheticResearchRequest } from './lib/virtual-research-cycle.mjs';
import { createSyntheticFileStore, createGitHubHttpStore } from './lib/research-reservations.mjs';
const [input, stateDir, ledgerConfig, ...extra] = process.argv.slice(2);
if (!input || !stateDir || extra.length || (input === '--demo' && ledgerConfig)) {
  console.error('Usage: node scripts/run-virtual-research.mjs --demo STATE_DIRECTORY | REQUEST.json STATE_DIRECTORY LEDGER_CONFIG.json'); process.exitCode = 2;
} else {
  try {
    let reservationStore;
    if (input === '--demo') reservationStore = createSyntheticFileStore(join(stateDir, 'synthetic-authority'));
    else {
      if (!ledgerConfig) throw new Error('Shared ledger configuration required; no local-only fallback');
      const config = JSON.parse(readFileSync(ledgerConfig, 'utf8'));
      if (!config || Object.keys(config).sort().join(',') !== 'branch,ledgerId,path,repository') throw new Error('Ledger config must contain only repository, branch, path, ledgerId; never store credentials in it');
      reservationStore = createGitHubHttpStore({ ...config, token: process.env.GITHUB_TOKEN });
      await reservationStore.verifyPrivateDestination();
    }
    const result = await runResearchCycle({ request: input === '--demo' ? syntheticResearchRequest() : JSON.parse(readFileSync(input, 'utf8')), stateDir, reservationStore });
    console.log(JSON.stringify(result, null, 2));
    // A successful research run is still blocked, never a promotion certificate.
    process.exitCode = result.eligible ? 0 : 3;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
