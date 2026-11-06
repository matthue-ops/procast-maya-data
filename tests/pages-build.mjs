import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile, rm, mkdtemp, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
const build = () => execFileSync(process.execPath, [path.join(root, 'scripts/build-pages.mjs')], { cwd: os.tmpdir(), stdio: 'pipe' });
build(); build();
assert.deepEqual((await readdir(output)).sort(), ['404.html', '_headers', 'aftersales-workbook.js', 'dataset-workspace.js', 'index.html', 'map-model.js', 'map-view.js', 'sync-changes.js', 'sync.js', 'vendor', 'workspace-store.js', 'workspace-tools.js', 'workspace.css']);
for (const file of ['index.html', 'sync.js', 'sync-changes.js', 'aftersales-workbook.js']) assert.deepEqual(await readFile(path.join(root,file)),await readFile(path.join(output,file)));
console.log('PASS repeatable build publishes only the expected files and preserves app bytes');
const unknown = path.join(output, '.pages-build-test-unexpected');
try {
 await writeFile(unknown, 'keep this test fixture', { flag:'wx' });
 assert.throws(build, /Unexpected file in dist/);
 assert.equal(await readFile(unknown,'utf8'),'keep this test fixture');
} finally { await rm(unknown,{force:true}); }
console.log('PASS unknown output files are rejected rather than uploaded or deleted');
const temporary = await mkdtemp(path.join(os.tmpdir(),'maya-pages-build-'));
const target = path.join(temporary,'sentinel');
try {
 await writeFile(target,'do not overwrite');
 await rm(path.join(output,'sync.js'));
 await symlink(target,path.join(output,'sync.js'));
 assert.throws(build, /Expected a regular file/);
 assert.equal(await readFile(target,'utf8'),'do not overwrite');
} finally {
 await rm(path.join(output,'sync.js'),{force:true});
 await rm(temporary,{recursive:true,force:true});
 build();
}
console.log('PASS build rejects symlink destinations and leaves the target untouched');
