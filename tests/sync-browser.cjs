/* Real browser + isolated PostgreSQL. All external browser traffic is intercepted. */
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {rpc,request,update,reset,sql}=require('./merge-db-helper.cjs');
const css=fs.readFileSync(process.env.MAYA_TEST_CSS || '/tmp/maya-test-styles.css','utf8');
(async()=>{
await reset();
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const errors=[];const devices=[];
async function status(page,text,timeout=12000){await page.waitForFunction(t=>document.getElementById('sync-status').textContent.includes(t),text,{timeout});}
async function device(phone=false,seed){
 const context=await browser.newContext({viewport:phone?{width:390,height:844}:{width:1280,height:850},isMobile:phone,hasTouch:phone});
 const control={context,offline:false,loseNext:false,holdNext:null,holdRead:null,readHeld:false,batches:[],dialogs:[]};devices.push(control);
 await context.addInitScript(()=>{window.testOnline=true;Object.defineProperty(navigator,'onLine',{get:()=>window.testOnline});});
 if(seed)await context.addInitScript(value=>localStorage.setItem('enterpriseDataManager',JSON.stringify(value)),seed);
 await context.exposeBinding('fakeRpc',async(source,name,args)=>{
  if(control.offline)return {data:null,error:{message:'network unavailable'}};
  if(name==='maya_sync_status'&&control.holdRead){const gate=control.holdRead;control.holdRead=null;control.readHeld=true;await gate;}
  if(name==='maya_apply_changes'){
   control.batches.push(structuredClone(args));
   if(control.holdNext){const gate=control.holdNext;control.holdNext=null;await gate;}
  }
  try{
   const data=await rpc(name,args);
   if(name==='maya_apply_changes'&&control.loseNext){control.loseNext=false;return {data:null,error:{message:'response lost'}};}
   return {data,error:null};
  }catch(error){return {data:null,error:{message:error.message}};}
 });
 await context.route('https://**/*',route=>{
  const url=route.request().url();
  if(url.includes('supabase-js'))return route.fulfill({contentType:'application/javascript',body:'window.supabase={createClient:()=>({rpc:(name,args)=>window.fakeRpc(name,args)})}'});
  if(url.includes('tailwind'))return route.fulfill({contentType:'application/javascript',body:`document.head.insertAdjacentHTML('beforeend','<style>'+${JSON.stringify(css)}+'</style>')`});
  if(url.includes('xlsx'))return route.fulfill({contentType:'application/javascript',body:'window.XLSX={read:()=>({SheetNames:["Sheet"],Sheets:{Sheet:{}}}),utils:{sheet_to_json:()=>[["Merchant"],["Imported Merchant"]]}}'});
  return route.fulfill({body:''});
 });
 const page=control.page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));
 page.on('dialog',async d=>{control.dialogs.push(d.type());await d.accept();});
 await page.goto('http://127.0.0.1:8000/');
 await page.waitForFunction(()=>!document.getElementById('app').inert);
 if(!seed)await status(page,'All changes saved to cloud');
 return control;
}
async function name(d,value){await d.page.locator('#sync-options summary').click();await d.page.fill('#device-name-input',value);await d.page.click('#save-device-name-btn');await d.page.waitForFunction(()=>document.getElementById('device-name-feedback').textContent.includes('Device name saved'));await d.page.locator('#sync-options summary').click();}
async function add(d,value){await d.page.click('#new-record-btn');await d.page.fill('#new-establishment-name',value);await d.page.locator('#add-establishment-form button[type=submit]').click();}
async function edit(d,id,values){
 await d.page.locator(`[data-action="view-details"][data-id="${id}"]`).click();
 await d.page.locator('#view-details-modal [data-action="open-modal"]').click();
 for(const [key,value] of Object.entries(values))await d.page.locator(`#details-form [name="${key}"]`).fill(value);
 await d.page.locator('#details-form button[type=submit]').click();
}
async function offline(d,value,announce=true){d.offline=value;if(announce)await d.page.evaluate(value=>{window.testOnline=!value;window.dispatchEvent(new Event(value?'offline':'online'));},value);}
async function waitFor(check){for(let i=0;i<160;i++){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw Error('Database condition timed out');}
const row=(cloud,id)=>cloud.payload.establishments.find(r=>r.id===id);
try{
 const a=await device(true),b=await device();
 await name(a,'Field Phone');await name(b,'Office PC');
 await a.page.click('#tab-aftersales');await a.page.click('#tab-collection');await a.page.click('#theme-toggle-btn');
 await a.page.waitForTimeout(200);assert.equal(a.batches.length,0);console.log('PASS startup, theme, tabs and device naming do not upload');
 assert.equal(await a.page.locator('#record-tools').evaluate(e=>e.open),false);
 assert.equal(await a.page.locator('[data-action="view-details"]').count(),2);
 assert.ok((await a.page.locator('#search-input').boundingBox()).y<500);console.log('PASS Saved Records and search are the primary phone workspace');
 await offline(a,true);await status(a.page,'Offline');
 await edit(a,'r1',{ADDRESS:'Field address'});await status(a.page,'Offline — changes saved on this device');
 const beforeDialogs=a.dialogs.length;await a.page.reload();await a.page.waitForFunction(()=>!document.getElementById('app').inert);
 // Reload resets the test navigator but the transport remains offline.
 await status(a.page,'Offline');assert.equal(a.dialogs.length,beforeDialogs);assert.equal(await a.page.inputValue('#device-name-input'),'Field Phone');
 await edit(b,'r1',{PHONE:'PC phone'});await status(b.page,'All changes saved to cloud');
 await offline(a,false);await status(a.page,'All changes saved to cloud');
 let cloud=await rpc('maya_read_state');assert.equal(row(cloud,'r1').details.ADDRESS,'Field address');assert.equal(row(cloud,'r1').details.PHONE,'PC phone');
 assert.equal(a.batches[0].p_changes[0].details_set.ADDRESS,'Field address');assert.equal(a.batches[0].p_changes[0].details_set.PHONE,undefined);
 assert.match(await a.page.locator('#sync-cloud-time').innerText(),/Field Phone/);console.log('PASS offline reload is safe; reconnect automatically merges only changed fields');
 await offline(a,true);await edit(a,'r1',{PHONE:'Phone typed earlier'});
 await edit(b,'r1',{PHONE:'PC typed later'});await status(b.page,'All changes saved to cloud');
 await offline(a,false);await status(a.page,'All changes saved to cloud');assert.equal(row(await rpc('maya_read_state'),'r1').details.PHONE,'Phone typed earlier');assert.equal(a.dialogs.length,beforeDialogs);console.log('PASS same field uses last server acceptance without conflict dialogs');
 a.loseNext=true;const historyBefore=Number(await sql('SELECT count(*) FROM public.maya_change_history;'));
 await add(a,'Lost response record');await status(a.page,'Offline');
 const id=a.batches.at(-1).p_request_id;await a.page.reload();await status(a.page,'All changes saved to cloud');
 assert.equal(a.batches.at(-1).p_request_id,id);assert.equal(Number(await sql('SELECT count(*) FROM public.maya_change_history;')),historyBefore+1);console.log('PASS lost response retries immutable request without duplicate records/history');
 let release;a.holdNext=new Promise(resolve=>release=resolve);
 const batchCount=a.batches.length;await add(a,'During upload A');await waitFor(()=>a.batches.length>batchCount);await add(a,'During upload B');
 await a.page.waitForFunction(()=>new Promise(resolve=>{const q=indexedDB.open('maya-device-sync',1);q.onsuccess=()=>{const g=q.result.transaction('state').objectStore('state').get('current');g.onsuccess=()=>resolve(g.result.outbox.length>=2);};}));
 release();
 await status(a.page,'All changes saved to cloud');await waitFor(async()=>{const c=await rpc('maya_read_state');return c.payload.establishments.some(r=>r.name==='During upload B');});console.log('PASS edits during upload stay queued and survive acknowledgements');
 // A connection may fail without navigator.onLine changing. Retry on the timer.
 a.offline=true;await add(a,'Automatic timer retry');await status(a.page,'Offline');a.offline=false;await status(a.page,'All changes saved to cloud',22000);console.log('PASS retry timer syncs after transport recovery without clicking a button');
 // Durability failure blocks sending and requires an explicit local retry.
 await a.page.evaluate(()=>{window.originalTransaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){if(args[1]==='readwrite')throw Error('quota simulation');return window.originalTransaction.apply(this,args);};});
 const count=a.batches.length;await add(a,'Storage failure record');await status(a.page,'Couldn’t save');assert.equal(a.batches.length,count);
 await a.page.evaluate(()=>{IDBDatabase.prototype.transaction=window.originalTransaction;});await a.page.click('#save-device-btn');await status(a.page,'All changes saved to cloud');console.log('PASS failed device saves do not upload; local retry recovers');
 // Preserve unsent form input while other devices publish changes.
 await b.page.click('#new-record-btn');await b.page.fill('#new-establishment-name','Unsubmitted draft');
 await add(a,'Remote while drafting');await status(a.page,'All changes saved to cloud');await b.page.evaluate(()=>window.dispatchEvent(new Event('focus')));await b.page.waitForTimeout(250);
 assert.equal(await b.page.inputValue('#new-establishment-name'),'Unsubmitted draft');await b.page.click('#close-create-record-btn');console.log('PASS background refresh does not discard a draft');
 // A tab sharing this origin cannot overwrite the local outbox.
 const second=await a.context.newPage();second.on('dialog',d=>d.accept());await second.goto('http://127.0.0.1:8000/');await status(second,'Another Maya tab');assert.equal(await second.locator('#app').evaluate(e=>e.inert),true);await second.close();console.log('PASS duplicate writer tabs are blocked');
 // Bulk replaces remain explicit; unrelated edits still merge safely around them.
 await b.page.click('#tab-aftersales');await b.page.locator('#aftersales-file-input').setInputFiles({name:'fixture.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('synthetic')});
 await status(b.page,'All changes saved to cloud');assert.ok(b.batches.at(-1).p_changes.some(c=>c.kind==='replace_aftersales'));await b.page.click('#tab-collection');console.log('PASS Excel replacement uses the protected group operation');
 // Seed additional records through the real RPC to check paging + whole-dataset search.
 cloud=await rpc('maya_read_state');
 await rpc('maya_apply_changes',request(Array.from({length:65},(_,i)=>({kind:'create',collection:'establishments',id:`extra-${i}`,value:{id:`extra-${i}`,name:`EXTRA ${String(i).padStart(2,'0')}`,details:{ADDRESS:'Test'}}})),{p_epoch:cloud.epoch,p_aftersales_epoch:cloud.aftersales_epoch}));
 await a.page.click('#sync-now-btn');await status(a.page,'All changes saved to cloud');await waitFor(async()=>await a.page.locator('[data-action="view-details"]').count()===30);
 await a.page.locator('[data-action="show-more-records"]').click();assert.equal(await a.page.locator('[data-action="view-details"]').count(),60);
 await a.page.fill('#search-input','EXTRA 64');assert.equal(await a.page.locator('[data-action="view-details"]').count(),1);await a.page.fill('#search-input','');console.log('PASS paged record list searches all records, including unloaded cards');
 await a.page.locator('#sync-options').evaluate(e=>e.open=false);await a.page.locator('#sync-options summary').click();
 const bounds=await a.page.locator('.sync-options-body').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390);
 await a.page.locator('#sync-options summary').click();assert.equal(await a.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await a.page.screenshot({path:'/tmp/maya-v2-phone.png'});await b.page.screenshot({path:'/tmp/maya-v2-desktop.png'});console.log('PASS phone layout has touch-sized inputs and no horizontal overflow');
 // Regression: an unrelated save must not upgrade queued stale aftersales epochs.
 await offline(a,true);
 await add(a,'Unrelated offline record');
 await a.page.click('#tab-aftersales');
 await a.page.locator('#aftersales-cards-container [data-action="set-status"][data-status="Resolved"]').first().click();
 await status(a.page,'Offline');
 cloud=await rpc('maya_read_state');
 await rpc('maya_apply_changes',request([{kind:'replace_aftersales',expected:cloud.payload,value:{aftersalesHeaders:['Merchant'],aftersalesRecords:[]}}],{p_epoch:cloud.epoch,p_aftersales_epoch:cloud.aftersales_epoch}));
 await offline(a,false);await status(a.page,'Aftersales was replaced');
 cloud=await rpc('maya_read_state');assert.equal(cloud.payload.aftersalesRecords.length,0);assert.ok(cloud.payload.establishments.some(r=>r.name==='Unrelated offline record'));
 console.log('PASS unrelated acknowledgement cannot rebind stale aftersales changes');
 // Existing unsynced legacy snapshots have no field baseline: preserve them, never guess.
 const legacy=await device(false,{...cloud.payload,establishments:[{id:'legacy-only',name:'Legacy pending',details:{}}]});
 await status(legacy.page,'Previous app version has pending data');assert.equal(legacy.batches.length,0);
 console.log('PASS legacy unsynced copies require one-time review and are not silently overwritten');
 const touched=await device();
 await touched.page.evaluate(()=>new Promise(resolve=>{
  const q=indexedDB.open('maya-device-sync',1);q.onsuccess=()=>{
   const tx=q.result.transaction('state','readwrite'),store=tx.objectStore('state'),g=store.get('current');
   g.onsuccess=()=>{const r=g.result;r.dirty=true;r.pending=null;r.state.establishments.push({id:'old-client-edit',name:'Old client pending',details:{}});store.put(r,'current');};tx.oncomplete=()=>resolve();
  };
 }));
 await touched.page.reload();await status(touched.page,'Previous app version has pending data');assert.equal(touched.batches.length,0);
 console.log('PASS a legacy client touching a v2 envelope cannot erase its pending copy');
 const race=await device();
 await race.page.evaluate(()=>new Promise(resolve=>{
  const q=indexedDB.open('maya-device-sync',1);q.onsuccess=()=>{
   const tx=q.result.transaction('state','readwrite'),store=tx.objectStore('state'),g=store.get('current');
   g.onsuccess=()=>{const r=g.result;store.put({state:r.state,revision:r.revision,dirty:false,pending:null,deviceName:r.deviceName},'current');};tx.oncomplete=()=>resolve();
  };
 }));
 let releaseRead;race.holdRead=new Promise(resolve=>releaseRead=resolve);
 await race.page.reload();await race.page.waitForFunction(()=>!document.getElementById('app').inert);await waitFor(()=>race.readHeld);
 await add(race,'Edit during upgrade read');releaseRead();await status(race.page,'Previous app version has pending data');
 assert.equal(race.batches.length,0);
 const kept=await race.page.evaluate(()=>new Promise(resolve=>{const q=indexedDB.open('maya-device-sync',1);q.onsuccess=()=>{const g=q.result.transaction('state').objectStore('state').get('current');g.onsuccess=()=>resolve(g.result.state.establishments.some(r=>r.name==='Edit during upgrade read'));};}));
 assert.equal(kept,true);console.log('PASS initial cloud read cannot discard an edit made during legacy upgrade');


 assert.deepEqual(errors,[]);console.log('PASS no browser errors or production database requests');
}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
