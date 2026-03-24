/**
 * Post-build smoke test. Validates both esbuild targets produced usable output.
 * Cannot fully require extension.js (needs vscode module), so validates structure.
 */
import { existsSync, statSync, readFileSync } from 'fs';
import assert from 'assert';

// 1. Check dist/extension.js exists, is non-empty, and exports activate/deactivate
const extPath = './dist/extension.js';
assert(existsSync(extPath), 'dist/extension.js missing');
const extStat = statSync(extPath);
assert(extStat.size > 0, 'dist/extension.js is empty');
const extContent = readFileSync(extPath, 'utf-8');
assert(extContent.includes('activate'), 'dist/extension.js missing activate export');
assert(extContent.includes('deactivate'), 'dist/extension.js missing deactivate export');

// 2. Check media/panel.js exists and is non-empty
assert(existsSync('./media/panel.js'), 'media/panel.js missing');
const panelStat = statSync('./media/panel.js');
assert(panelStat.size > 0, 'media/panel.js is empty');

// 3. Check media/panel.css exists
assert(existsSync('./media/panel.css'), 'media/panel.css missing');

// 4. Check package.json has correct main entry
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
assert(pkg.main === './dist/extension.js', `package.json main is "${pkg.main}", expected "./dist/extension.js"`);

console.log(`smoke: OK (extension.js ${(extStat.size / 1024).toFixed(1)}KB, panel.js ${(panelStat.size / 1024).toFixed(1)}KB, panel.css present)`);
