// Prints release notes (Markdown) for a version from the version history table in help.html.
// Usage: node tools/release-notes.mjs 0.6.0 [path/to/help.html]
import { readFileSync } from 'node:fs';

const [version, helpPath = new URL('../help.html', import.meta.url)] = process.argv.slice(2);
if (!version) { console.error('usage: node tools/release-notes.mjs <version> [help.html]'); process.exit(1); }
const html = readFileSync(helpPath, 'utf8');
const esc = version.replace(/\./g, '\\.');
const row = new RegExp(`<tr><td>${esc} \\(([^)]*)\\)</td><td>[^<]*</td><td>([\\s\\S]*?)</td></tr>`).exec(html);
const md = s => s.replace(/<b>(.*?)<\/b>/g, '**$1**').replace(/<i>(.*?)<\/i>/g, '*$1*').replace(/<code>(.*?)<\/code>/g, '`$1`')
  .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const lines = [];
if (row) {
  lines.push(`Released ${row[1]}.`, '');
  for (const item of md(row[2]).split(/;\s+/)) lines.push(`- ${item.charAt(0).toUpperCase()}${item.slice(1)}`);
} else lines.push(`Thistle Flow ${version}.`);
lines.push('', '**Beta software:** check important results against an established package before publishing.', '',
  'Download `thistle-flow.html` below and open it in a browser (no installation), or use the hosted app: https://actinomycetes.github.io/thistle-flow/ · Manual: https://actinomycetes.github.io/thistle-flow/help.html');
console.log(lines.join('\n'));
