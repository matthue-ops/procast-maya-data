import { copyFile, lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
const files = new Map([
    ['index.html', 'index.html'],
    ['sync.js', 'sync.js'],
    ['sync-changes.js', 'sync-changes.js'],
    ['404.html', 'cloudflare/404.html'],
    ['_headers', 'cloudflare/_headers']
]);

async function regularFile(file) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${file}`);
}

// Validate all inputs before changing any output. Never recursively publish the repo.
for (const source of files.values()) await regularFile(path.join(root, source));
const html = await readFile(path.join(root, 'index.html'), 'utf8');
for (const script of ['sync.js', 'sync-changes.js']) {
    if (!html.includes(`src="./${script}"`)) throw new Error(`Missing app script reference: ${script}`);
}

await mkdir(output, { recursive: true });
const outputStat = await lstat(output);
if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error('dist must be a real directory');
for (const entry of await readdir(output)) {
    if (!files.has(entry)) throw new Error(`Unexpected file in dist: ${entry}. Preserve or remove it manually before building.`);
    await regularFile(path.join(output, entry));
}
for (const [destination, source] of files) await copyFile(path.join(root, source), path.join(output, destination));
console.log(`Cloudflare Pages build: ${files.size} public files written to dist/`);
