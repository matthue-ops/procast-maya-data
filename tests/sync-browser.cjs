const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const empty={customFields:[],establishments:[],savedFilters:[],aftersalesHeaders:[],aftersalesRecords:[]};
let cloud={payload:structuredClone(empty),revision:'0',updated_at:'2026-11-03T00:00:00Z'};
let writes=0, offline=false, loseResponse=false, delaySave=null;
const receipts=new Map(); const errors=[];
async function device(){
 const context=await browser.newContext();
 await context.exposeBinding('fakeRpc',async(source,name,args)=>{
  if(offline) return {data:null,error:{message:'offline'}};
  if(name==='maya_read_state') return {data:structuredClone(cloud),error:null};
  if(name!=='maya_save_state') throw Error('Unexpected write path');
  if(delaySave) await delaySave;
  if(receipts.has(args.p_request_id)) return {data:{...receipts.get(args.p_request_id),status:'already_saved',current_revision:cloud.revision},error:null};
  if(args.p_expected_revision!==cloud.revision) return {data:{status:'conflict',request_id:args.p_request_id,current_revision:cloud.revision,current_updated_at:cloud.updated_at},error:null};
  writes++;cloud={payload:structuredClone(args.p_payload),revision:String(Number(cloud.revision)+1),updated_at:new Date().toISOString()};
  const data={status:'saved',request_id:args.p_request_id,saved_revision:cloud.revision,current_revision:cloud.revision,saved_at:cloud.updated_at};receipts.set(args.p_request_id,data);
  if(loseResponse){loseResponse=false;return {data:null,error:{message:'response lost'}};}
  return {data,error:null};
 });
 await context.route('https://**/*',route=>{
  const url=route.request().url();
  if(url.includes('supabase-js'))return route.fulfill({contentType:'application/javascript',body:'window.supabase={createClient:()=>({rpc:(name,args)=>window.fakeRpc(name,args)})}'});
  if(url.includes('tailwind'))return route.fulfill({contentType:'application/javascript',body:`document.head.insertAdjacentHTML('beforeend','<style>.hidden{display:none!important}</style>')`});
  if(url.includes('xlsx'))return route.fulfill({contentType:'application/javascript',body:'window.XLSX={}'});
  return route.fulfill({body:''});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.type()==='beforeunload'?d.accept():d.accept());
 await page.goto('http://127.0.0.1:8000/');
 await page.waitForFunction(()=>!document.getElementById('app').inert);
 await status(page,'Saved to cloud');
 return {context,page};
}
async function status(page,text){await page.waitForFunction(t=>document.getElementById('sync-status').textContent.includes(t),text,{timeout:10000});}
async function add(page,name){await page.fill('#new-establishment-name',name);await page.locator('#add-establishment-form button').click();}
async function waitWrites(n){for(let i=0;i<100&&writes<n;i++)await new Promise(r=>setTimeout(r,50));assert.equal(writes,n);}
const a=await device();assert.equal(writes,0);
assert.match(await a.page.locator('#sync-cloud-time').innerText(),/Unknown device/);
await a.page.click('#tab-aftersales');await a.page.click('#tab-collection');await a.page.click('#theme-toggle-btn');
await a.page.waitForTimeout(200);assert.equal(writes,0);console.log('PASS startup/navigation/theme never write');
const b=await device();
async function nameDevice(page,name){
 await page.locator('#sync-options summary').click();
 await page.fill('#device-name-input',name);await page.click('#save-device-name-btn');
 await page.waitForFunction(()=>document.getElementById('device-name-feedback').textContent.includes('Device name saved'));
 await page.locator('#sync-options summary').click();
}
await nameDevice(a.page,'Field Phone');await nameDevice(b.page,'Office PC');
assert.equal(writes,0);console.log('PASS device naming does not upload or change revision');
await add(a.page,'PHONE');await waitWrites(1);await status(a.page,'Saved to cloud');
assert.equal(cloud.payload._syncSource.deviceName,'Field Phone');
assert.match(await a.page.locator('#sync-cloud-time').innerText(),/Field Phone/);
console.log('PASS source device accompanies cloud save');
await add(b.page,'STALE COMPUTER');await status(b.page,'Newer cloud data');assert.equal(writes,1);assert.equal(cloud.payload.establishments[0].name,'PHONE');console.log('PASS stale device preserves cloud and local conflict');
await b.page.click('#use-cloud-btn');await status(b.page,'Saved to cloud');assert.equal(writes,1);
assert.match(await b.page.locator('#sync-cloud-time').innerText(),/Field Phone/);
assert.equal(await b.page.inputValue('#device-name-input'),'Office PC');
console.log('PASS cloud source is distinct from this device name');
offline=true;
await add(a.page,'OFFLINE FIELD');await status(a.page,'Sync paused');
await a.page.reload();await a.page.waitForFunction(()=>!document.getElementById('app').inert);await status(a.page,'Sync paused');
assert.equal(await a.page.inputValue('#device-name-input'),'Field Phone');
assert.match(await a.page.locator('#establishments-header').innerText(),/2/);console.log('PASS offline committed edits survive reload');
offline=false;await a.page.click('#sync-now-btn');await waitWrites(2);await status(a.page,'Saved to cloud');assert.equal(cloud.payload.establishments.length,2);
loseResponse=true;await add(a.page,'LOST RESPONSE');await waitWrites(3);await status(a.page,'Sync paused');
await a.page.reload();await status(a.page,'Saved to cloud');assert.equal(writes,3);console.log('PASS lost response reconciles without duplicate save');
let release;delaySave=new Promise(r=>release=r);
await add(a.page,'IN FLIGHT');await a.page.waitForTimeout(200);await add(a.page,'LATER EDIT');release();delaySave=null;
await waitWrites(5);await status(a.page,'Saved to cloud');assert.equal(cloud.payload.establishments.length,5);console.log('PASS edits during in-flight save retained and synced');
// A second tab sharing storage is blocked before editing.
const second=await a.context.newPage();second.on('dialog',d=>d.accept());await second.goto('http://127.0.0.1:8000/');await status(second,'Another Maya tab');assert.equal(await second.locator('#app').evaluate(e=>e.inert),true);console.log('PASS second writer tab is blocked');await second.close();
// Stale local choice explicitly replaces only a freshly read revision.
await add(b.page,'EXPLICIT LOCAL');await status(b.page,'Newer cloud data');await b.page.click('#replace-cloud-btn');await waitWrites(6);await status(b.page,'Saved to cloud');assert.equal(cloud.payload.establishments.length,2);console.log('PASS explicit replacement requires confirmation and checked revision');
// Storage failure must pause writes, then an explicit retry can recover.
await a.page.click('#sync-now-btn');await a.page.waitForTimeout(300);
await a.page.evaluate(()=>{window.originalTransaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){if(args[1]==='readwrite')throw Error('quota simulation');return window.originalTransaction.apply(this,args)}});
const beforeFailure=writes;await add(a.page,'STORAGE FAILURE');await status(a.page,'Local save failed');assert.equal(writes,beforeFailure);
await a.page.evaluate(()=>{IDBDatabase.prototype.transaction=window.originalTransaction});
await a.page.click('#sync-now-btn');await a.page.waitForTimeout(300);await status(a.page,'Saved to cloud');await waitWrites(beforeFailure+1);console.log('PASS local storage failure pauses cloud writes and retains work');
// A pending form must not be replaced by a refresh.
await b.page.fill('#new-establishment-name','UNSUBMITTED');
cloud={...cloud,revision:String(Number(cloud.revision)+1),payload:{...cloud.payload,establishments:[]}};
await b.page.click('#sync-now-btn');await status(b.page,'finish or close your form');assert.equal(await b.page.inputValue('#new-establishment-name'),'UNSUBMITTED');console.log('PASS cloud refresh preserves unsubmitted form');
// Compact controls work on phone-width screens without horizontal overflow.
await a.page.setViewportSize({width:375,height:812});
await a.page.locator('#sync-options').evaluate(e=>e.open=false);
await a.page.locator('#sync-options summary').click();
assert.equal(await a.page.locator('#sync-options').evaluate(e=>e.open),true);
const bounds=await a.page.locator('.sync-options-body').boundingBox();
assert.ok(bounds.x>=0 && bounds.x+bounds.width<=375,'Options panel must fit the phone viewport');
await a.page.locator('#sync-options summary').click();
console.log('PASS compact options fit phone viewport');
await a.page.screenshot({path:'/tmp/maya-device-phone.png'});
await a.page.setViewportSize({width:1280,height:800});
await a.page.screenshot({path:'/tmp/maya-device-desktop.png'});
assert.deepEqual(errors,[]);console.log('PASS no page errors');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
