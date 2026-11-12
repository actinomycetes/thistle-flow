// Bundles Thistle Flow into one self-contained HTML file (dist/thistle-flow.html) that opens
// directly from disk (file://) without a web server. No dependencies.
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const order = ['version', 'transforms', 'fcs', 'model', 'gates', 'render', 'autogate', 'vector', 'ui', 'plotview', 'figureview', 'compview', 'zip', 'demo', 'workspace', 'properties', 'app'];
let js = '';
for (const m of order) {
  let src = readFileSync(join(root, 'js', m + '.js'), 'utf8');
  src = src.replace(/^import[^;]+;\s*$/gm, '');          // drop imports (everything shares one scope)
  src = src.replace(/^export\s+(?=(const|let|function|class|async)\b)/gm, '');
  if (/^\s*export\b/m.test(src)) throw new Error(`Unsupported export form in ${m}.js`);
  js += `\n// ---- ${m}.js ----\n` + src;
}
js = `(() => {\n'use strict';\n${js}\n})();\n`;
mkdirSync(join(root, 'dist'), { recursive: true });
const tmp = join(root, 'dist', '.bundle-check.js');
writeFileSync(tmp, js);
try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'inherit' }); } finally { unlinkSync(tmp); } // catches duplicate top-level names
const css = readFileSync(join(root, 'css', 'style.css'), 'utf8');
let html = readFileSync(join(root, 'index.html'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="css\/style.css">/, () => `<style>\n${css}</style>`);
html = html.replace(/<script type="module" src="js\/app.js"><\/script>/, () => `<script>\n${js.replace(/<\/script/gi, '<\\/script')}</script>`);
// a single file has no help.html next to it: the help panel shows a built-in copy of the manual,
// and "Open in a new tab" links to the hosted manual
const help = readFileSync(join(root, 'help.html'), 'utf8');
html = html.split('href="help.html"').join('href="https://actinomycetes.github.io/thistle-flow/help.html"');
html = html.replace('<script>\n(() => {', () => `<script>window.__HELP_HTML__ = ${JSON.stringify(help).replace(/<\/(script)/gi, '<\\/$1')};</script>\n<script>\n(() => {`);
writeFileSync(join(root, 'dist', 'thistle-flow.html'), html);
console.log(`dist/thistle-flow.html written (${(html.length / 1024).toFixed(0)} KB)`);
