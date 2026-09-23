/* Runs every tests/test_*.js in its own Node process and reports which failed.
 * The app is ES modules; tests load them with node:vm's SourceTextModule, which
 * Node still keeps behind --experimental-vm-modules. Run: npm test */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const flags = ['--experimental-vm-modules'];
if (process.allowedNodeEnvironmentFlags.has('--disable-warning')) flags.push('--disable-warning=ExperimentalWarning');

const only = process.argv.slice(2);   // npm test -- sync theme   → just those files
const files = fs.readdirSync(__dirname)
  .filter(f => /^test_.*\.js$/.test(f))
  .filter(f => !only.length || only.some(o => f.includes(o)))
  .sort();

const failed = [];
for (const f of files) {
  console.log(`\n═══ ${f} ═══`);
  const r = spawnSync(process.execPath, [...flags, path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(f);
}
console.log(`\n${files.length - failed.length}/${files.length} test files passed${failed.length ? ' — failed: ' + failed.join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);
