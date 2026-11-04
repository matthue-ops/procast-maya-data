/* Hosting test only. External browser calls are mocked; live Supabase is never used. */
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {chromium}=require('playwright');
const base=(process.env.PAGES_TEST_URL||'http://127.0.0.1:8788').replace(/\/$/,'');
const origin=new URL(base).origin;
const fixture=require('./merge-fixture.cjs');
const css=fs.readFileSync(process.env.MAYA_TEST_CSS||'/tmp/maya-pages-test.css','utf8');
(async()=>{
 for(const file of ['','sync.js','sync-changes.js']){
  const response=await fetch(`${base}/${file}`);assert.equal(response.status,200);
  assert.match(response.headers.get('cache-control'),/max-age=0/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.match(response.headers.get('content-type'),file?/javascript/:/text\/html/);
  const actual=Buffer.from(await response.arrayBuffer());const expected=fs.readFileSync(path.join(__dirname,'..',file||'index.html'));assert.deepEqual(actual,expected);
 }
 const index=await fetch(`${base}/index.html`,{redirect:'manual'});assert.ok([200,301,302,307,308].includes(index.status));
 if(index.status!==200)assert.equal(new URL(index.headers.get('location'),base).pathname,'/');
 for(const file of ['missing.js','some/unknown/route','auth/callback','AGENTS.md','SYNC-SETUP.md','supabase/manual/04-automatic-merge.sql','docs/proposals/approved-device-access.md','tests/sync-browser.cjs','scripts/build-pages.mjs','wrangler.jsonc','.git/config']){
  const response=await fetch(`${base}/${file}`);assert.equal(response.status,404,`must not serve ${file}`);assert.match(await response.text(),/Page not found/);
 }
 console.log('PASS Pages HTTP routes, script MIME types, cache rules, 404s and private-file exclusion');
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  let cloud=structuredClone(fixture),revision=0,writes=0;const receipts=new Map();const errors=[];
  await context.exposeBinding('pagesTestRpc',async(source,name,args)=>{
   if(name==='maya_read_state'||name==='maya_sync_status')return {data:{protocol:2,payload:cloud,revision:String(revision),epoch:'0',aftersales_epoch:'0',updated_at:'2026-11-04T00:00:00Z',device_name:'Hosting test'},error:null};
   assert.equal(name,'maya_apply_changes');
   if(receipts.has(args.p_request_id))return {data:{...receipts.get(args.p_request_id),status:'already_saved'},error:null};
   for(const op of args.p_changes){assert.equal(op.kind,'create');assert.equal(op.collection,'establishments');cloud.establishments.push(op.value);}
   writes++;revision++;
   const result={status:'saved',request_id:args.p_request_id,revision:String(revision),epoch:'0',aftersales_epoch:'0',saved_at:new Date().toISOString(),device_name:args.p_device_name,skipped:[]};receipts.set(args.p_request_id,result);return {data:result,error:null};
  });
  await context.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.origin===origin)return route.continue();
   if(url.hostname==='cdn.jsdelivr.net'&&url.pathname.includes('supabase-js'))return route.fulfill({contentType:'application/javascript',body:'window.supabase={createClient:()=>({rpc:(name,args)=>window.pagesTestRpc(name,args)})}'});
   if(url.hostname==='cdn.tailwindcss.com')return route.fulfill({contentType:'application/javascript',body:`document.head.insertAdjacentHTML('beforeend','<style>'+${JSON.stringify(css)}+'</style>')`});
   if(url.hostname==='cdn.jsdelivr.net'&&url.pathname.includes('xlsx'))return route.fulfill({contentType:'application/javascript',body:'window.XLSX={}'});
   if(url.hostname==='fonts.googleapis.com')return route.fulfill({contentType:'text/css',body:''});
   return route.abort();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/`);await page.waitForFunction(()=>document.getElementById('sync-status').textContent==='All changes saved to cloud');
  assert.equal(await page.locator('[data-action="view-details"]').count(),2);
  await page.fill('#search-input','CLIENT B');assert.equal(await page.locator('[data-action="view-details"]').count(),1);
  await page.fill('#search-input','');await page.click('#tab-aftersales');assert.equal(await page.locator('#view-aftersales-container').isVisible(),true);
  await page.click('#tab-collection');await page.click('#theme-toggle-btn');assert.equal(writes,0);
  await context.setOffline(true);await page.waitForFunction(()=>document.getElementById('sync-status').textContent.startsWith('Offline'));
  await page.click('#new-record-btn');await page.fill('#new-establishment-name','Offline hosting test');await page.locator('#add-establishment-form button[type=submit]').click();
  await page.waitForFunction(()=>document.getElementById('sync-status').textContent==='Offline — changes saved on this device');assert.equal(writes,0);
  await context.setOffline(false);await page.waitForFunction(()=>document.getElementById('sync-status').textContent==='All changes saved to cloud');assert.equal(writes,1);
  assert.ok(cloud.establishments.some(r=>r.name==='Offline hosting test'));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  await page.screenshot({path:'/tmp/maya-pages-phone.png'});
  console.log('PASS browser startup, search, tabs, theme, mobile layout and offline/reconnect with synthetic data only');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
