#!/usr/bin/env node
// Deliberate double-check before `vsce publish`. A Marketplace release is public
// and not cleanly reversible per-version, so it must never fire accidentally or
// non-interactively (e.g. an agent running `npm run vsce:publish` in a non-TTY
// tool call). This guard requires an interactive terminal AND typing the exact
// version to confirm. For intentional CI/scripted use, set SERAC_PUBLISH_YES to
// the exact package version as an explicit opt-out.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const version = pkg.version;

function abort(msg) {
  console.error(`\n✗ Marketplace publish blocked: ${msg}\n`);
  process.exit(1);
}

// Explicit non-interactive opt-out — must name the exact version being published.
if (process.env.SERAC_PUBLISH_YES !== undefined) {
  if (process.env.SERAC_PUBLISH_YES === version) {
    console.log(`Publish confirmed via SERAC_PUBLISH_YES for v${version}.`);
    process.exit(0);
  }
  abort(`SERAC_PUBLISH_YES="${process.env.SERAC_PUBLISH_YES}" does not match package version "${version}".`);
}

// No TTY → refuse. This is the line that stops an automated/agent publish: a
// tool-call shell has no interactive stdin, so the release simply will not go.
if (!process.stdin.isTTY) {
  abort('not an interactive terminal. Run `npm run vsce:publish` yourself in a terminal, '
    + `or set SERAC_PUBLISH_YES=${version} to confirm a non-interactive publish.`);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log(`\n⚠️  About to publish snowmeltio.serac-claude-code v${version} to the VS Code Marketplace.`);
console.log('   This is public and is not cleanly reversible per-version.');
rl.question(`   Type the version (${version}) to confirm, or anything else to abort: `, (answer) => {
  rl.close();
  if (answer.trim() === version) {
    console.log('Confirmed.\n');
    process.exit(0);
  }
  abort('confirmation did not match.');
});
