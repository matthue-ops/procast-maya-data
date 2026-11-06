import { copyFile, lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
const files = new Map([
    ['index.html', 'index.html'],
    ['sync.js', 'sync.js'],
    ['sync-changes.js', 'sync-changes.js'],
    ['aftersales-workbook.js', 'aftersales-workbook.js'],
    ['workspace-tools.js', 'workspace-tools.js'],
    ['workspace-store.js', 'workspace-store.js'],
    ['dataset-workspace.js', 'dataset-workspace.js'],
    ['map-model.js', 'map-model.js'],
    ['map-view.js', 'map-view.js'],
    ['workspace.css', 'workspace.css'],
    ['vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.js'],
    ['vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.css'],
    ['vendor/leaflet/LICENSE', 'vendor/leaflet/LICENSE'],
    ['vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers.png'],
    ['vendor/leaflet/images/layers-2x.png', 'vendor/leaflet/images/layers-2x.png'],
    ['vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-icon.png'],
    ['vendor/leaflet/images/marker-icon-2x.png', 'vendor/leaflet/images/marker-icon-2x.png'],
    ['vendor/leaflet/images/marker-shadow.png', 'vendor/leaflet/images/marker-shadow.png'],
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
for (const script of ['sync.js', 'sync-changes.js', 'aftersales-workbook.js', 'workspace-tools.js', 'workspace-store.js', 'dataset-workspace.js', 'map-model.js', 'map-view.js']) {
    if (!html.includes(`src="./${script}"`)) throw new Error(`Missing app script reference: ${script}`);
}

await mkdir(output, { recursive: true });
const outputStat = await lstat(output);
if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error('dist must be a real directory');
const directories = new Set([...files.keys()].flatMap(file => {
    const result = []; let directory = path.dirname(file);
    while (directory !== '.') { result.push(directory); directory = path.dirname(directory); }
    return result;
}));
async function check(directory = '') {
    for (const entry of await readdir(path.join(output, directory))) {
        const relative = directory ? `${directory}/${entry}` : entry;
        const stat = await lstat(path.join(output, relative));
        if (stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${relative}`);
        if (stat.isDirectory() && directories.has(relative)) await check(relative);
        else if (stat.isFile() && files.has(relative)) await regularFile(path.join(output, relative));
        else throw new Error(`Unexpected file in dist: ${relative}. Preserve or remove it manually before building.`);
    }
}
await check();
for (const [destination, source] of files) {
    await mkdir(path.dirname(path.join(output, destination)), { recursive: true });
    await copyFile(path.join(root, source), path.join(output, destination));
}
console.log(`Cloudflare Pages build: ${files.size} public files written to dist/`);
