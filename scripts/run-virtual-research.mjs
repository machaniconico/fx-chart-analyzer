#!/usr/bin/env node
/** Offline only. Usage: node scripts/run-virtual-research.mjs (REQUEST.json | --demo) STATE_DIRECTORY */
import { readFileSync } from 'node:fs';
import { runResearchCycle, syntheticResearchRequest } from './lib/virtual-research-cycle.mjs';
const [input, stateDir, ...extra] = process.argv.slice(2);
if (!input || !stateDir || extra.length) {
  console.error('Usage: node scripts/run-virtual-research.mjs (REQUEST.json | --demo) STATE_DIRECTORY'); process.exitCode = 2;
} else {
  try {
    const result = runResearchCycle({ request: input === '--demo' ? syntheticResearchRequest() : JSON.parse(readFileSync(input, 'utf8')), stateDir });
    console.log(JSON.stringify(result, null, 2));
    // A successful research run is still blocked, never a promotion certificate.
    process.exitCode = result.eligible ? 0 : 3;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
