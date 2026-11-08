import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
const rollback = process.env.PROCAST_PWA_ROLLBACK === '1';
const files = new Map([
    ['index.html', 'index.html'],
    ['pwa.js', 'pwa.js'],
    ['manifest.webmanifest', 'manifest.webmanifest'],
    ['service-worker.js', rollback ? 'scripts/service-worker.rollback.js' : 'scripts/service-worker.template.js'],
    ['icons/procast-192.png', 'icons/procast-192.png'],
    ['icons/procast-512.png', 'icons/procast-512.png'],
    ['icons/procast-maskable-512.png', 'icons/procast-maskable-512.png'],
    ['icons/apple-touch-icon.png', 'icons/apple-touch-icon.png'],
    ['vendor/supabase/supabase.js', 'vendor/supabase/supabase.js'],
    ['vendor/supabase/LICENSE', 'vendor/supabase/LICENSE'],
    ['vendor/xlsx/xlsx.bundle.js', 'vendor/xlsx/xlsx.bundle.js'],
    ['vendor/xlsx/LICENSE', 'vendor/xlsx/LICENSE'],
    ['vendor/tailwind/app.css', 'vendor/tailwind/app.css'],
    ['vendor/tailwind/LICENSE', 'vendor/tailwind/LICENSE'],
    ['vendor/inter/inter.css', 'vendor/inter/inter.css'],
    ['vendor/inter/inter-latin.woff2', 'vendor/inter/inter-latin.woff2'],
    ['vendor/inter/LICENSE', 'vendor/inter/LICENSE'],
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
for (const script of ['sync.js', 'sync-changes.js', 'aftersales-workbook.js', 'workspace-tools.js', 'workspace-store.js', 'dataset-workspace.js', 'map-model.js', 'map-view.js', 'pwa.js']) {
    if (!html.includes(`src="./${script}"`)) throw new Error(`Missing app script reference: ${script}`);
}


// The worker and every shell file share a content-derived release. Integrity
// verification prevents a partial CDN deployment from installing mixed versions.
const stylesHash = createHash('sha256').update(await readFile(path.join(root,'index.html')))
    .update(await readFile(path.join(root,'styles/tailwind.css'))).update('tailwindcss@3.4.17').digest('hex');
if (!(await readFile(path.join(root,'vendor/tailwind/app.css'),'utf8')).startsWith(`/* Procast styles source-sha256: ${stylesHash} */`)) {
    throw new Error('Offline styles are stale. Run node scripts/compile-pwa-styles.mjs and commit vendor/tailwind/app.css.');
}
const assets = [];
const releaseHash = createHash('sha256');
for (const [destination,source] of files) {
    const bytes = await readFile(path.join(root,source));
    releaseHash.update(destination).update(bytes);
    if (['service-worker.js','404.html','_headers'].includes(destination) || destination.endsWith('/LICENSE')) continue;
    const integrity = 'sha256-' + createHash('sha256').update(bytes).digest('base64');
    // Pages redirects /index.html to /. Precache the canonical URL only.
    if (destination === 'index.html') assets.push({url:'./',integrity});
    else assets.push({url:'./'+destination,integrity});
}
const release = releaseHash.digest('hex').slice(0,24);
const worker = (await readFile(path.join(root,files.get('service-worker.js')),'utf8'))
    .replace('__PWA_RELEASE__',JSON.stringify(release)).replace('__PWA_ASSETS__',JSON.stringify(assets));
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
    if (destination === 'service-worker.js') await writeFile(path.join(output,destination),worker);
    else if (rollback && destination === 'index.html') await writeFile(path.join(output,destination),html.replace('<script src="./pwa.js"></script>','').replace('id="pwa-install-btn"','id="pwa-install-btn" hidden').replace('Install to open Procast in its own app window.','Offline app setup is temporarily disabled. Device records are unchanged.'));
    else await copyFile(path.join(root, source), path.join(output, destination));
}
console.log(`Cloudflare Pages build: ${files.size} public files written to dist/`);
