/* Boots the app in jsdom from its real ES modules: js/main.js and everything it
 * imports. jsdom does not run <script type="module">, so the modules are linked
 * with node:vm's SourceTextModule inside the jsdom window's own context. That is
 * the same code the browser runs, in strict mode, with real import bindings.
 * It needs `node --experimental-vm-modules`, which `npm test` passes.
 *
 * Tests reach app state the way they did when the app was one global script:
 * every top-level binding of every module gets a live getter/setter on window,
 * so w.eval('timers'), w.eval('todoIdCounter++'), w.eval('isMobileLayout = () => false')
 * and w.goTab('lists') all read or write the module's own variable. That bridge is
 * test-only; the shipped modules put nothing on window except inline-handler
 * functions (see js/main.js). */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*><\/script>/g, '')   // Firebase SDK + js/main.js (loaded below)
  .replace(/<link[^>]*fonts\.googleapis[^>]*>/g, '');

if (typeof vm.SourceTextModule !== 'function') {
  throw new Error('Run the tests with `node --experimental-vm-modules` (npm test does this).');
}

/* A module's top-level declarations. The modules keep one declaration per
 * statement, starting at column 0, so a line scan finds them all. */
const DECL = /^(?:export\s+)?(?:async\s+)?(function\s*\*?|let|const|var|class)\s+([A-Za-z_$][\w$]*)/gm;
function withBridge(source) {
  const members = [];
  for (const [, kind, name] of source.matchAll(DECL)) {
    members.push(`get ${name}() { return ${name}; }`);
    if (kind !== 'const' && kind !== 'class') members.push(`set ${name}(v) { ${name} = v; }`);
  }
  return `${source}\nexport const __bindings = { ${members.join(', ')} };\n`;
}

/* options:
 *   storage   { key: value } seeded into localStorage before the app starts
 *   url       page URL (default https://localhost/worky/)
 *   before    fn(window) to install stubs (fetch, firebase, …) before the app starts
 *   transform fn(source, 'js/x.js') → source, to instrument a module in one test
 *   bridge    false to load the modules untouched (the smoke test does) */
async function loadApp({ storage, url = 'https://localhost/worky/', before, transform, bridge = true } = {}) {
  const errors = [];                         // uncaught errors, also printed as before
  const virtualConsole = new VirtualConsole();
  virtualConsole.forwardTo(console);
  virtualConsole.on('jsdomError', e => errors.push(e));
  const dom = new JSDOM(HTML, { url, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole });
  const w = dom.window;
  if (storage) Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
  Object.defineProperty(w, 'confirm', { value: () => true, writable: true, configurable: true });
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  if (before) before(w);

  const context = dom.getInternalVMContext();
  const modules = new Map();
  const load = file => {
    if (modules.has(file)) return modules.get(file);
    let source = fs.readFileSync(file, 'utf8');
    if (transform) source = transform(source, path.relative(ROOT, file).split(path.sep).join('/'));
    if (bridge) source = withBridge(source);
    const mod = new vm.SourceTextModule(source, { context, identifier: pathToFileURL(file).href });
    modules.set(file, mod);
    return mod;
  };
  const main = load(path.join(ROOT, 'js', 'main.js'));
  await main.link((specifier, referrer) =>
    load(path.resolve(path.dirname(fileURLToPath(referrer.identifier)), specifier)));
  await main.evaluate();

  if (bridge) {
    for (const mod of modules.values()) {
      const descs = Object.getOwnPropertyDescriptors(mod.namespace.__bindings);
      for (const [name, { get, set }] of Object.entries(descs)) {
        // Never shadow something jsdom's window already has, except the function
        // main.js put there for an inline handler, or an element reachable by its
        // id (window.digestPromptText is a <textarea>; the old global function
        // declaration shadowed it the same way).
        if (name in w) {
          const cur = w[name];
          const byId = cur instanceof w.Element || cur instanceof w.HTMLCollection;
          if (!byId && cur !== get()) continue;
        }
        Object.defineProperty(w, name, { get, set, configurable: true });
      }
    }
  }
  return { dom, w, d: w.document, modules, errors };
}

module.exports = { loadApp, ROOT };
