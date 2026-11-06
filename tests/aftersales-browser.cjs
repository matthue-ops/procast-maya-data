const assert=require('node:assert/strict');const fs=require('node:fs');const {chromium}=require('playwright');
const XLSX=require(process.env.MAYA_XLSX_MODULE||'/tmp/maya-excel-tests/node_modules/xlsx-js-style');
const A=require('../aftersales-workbook.js');
const css=fs.readFileSync(process.env.MAYA_TEST_CSS||'/tmp/maya-aftersales-test.css','utf8');
const bundle=fs.readFileSync(require.resolve('xlsx-js-style/dist/xlsx.bundle.js',{paths:[process.env.MAYA_XLSX_MODULE||'/tmp/maya-excel-tests/node_modules']}),'utf8');
const filename='Field Report November.xlsx';
const headers=['OWNER','Merchant Name','DBA Name'];
const rows=[['CHOMART','ALPHA','A','None'],['CHOMART','BETA','B','Resolved'],['CHOMART','GAMMA','C','Unresolved'],['OTHER','DELTA','D','None'],['OTHER','EPSILON','E','Resolved']];
let cloud={customFields:[],establishments:[],savedFilters:[],aftersalesHeaders:headers,aftersalesRecords:rows.map(([owner,merchant,dba,status],i)=>({id:`a${i}`,merchantName:merchant,dbaName:dba,details:{OWNER:owner,'Merchant Name':merchant,'DBA Name':dba},status,_sourceFileName:filename}))};
let revision=0,groupEpoch=0,writes=0;const receipts=new Map(),errors=[];
(async()=>{
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try{
 async function device(){
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,acceptDownloads:true});
  await context.exposeBinding('aftersalesRpc',async(source,name,args)=>{
   if(['maya_read_state','maya_sync_status'].includes(name))return {data:{protocol:2,payload:structuredClone(cloud),revision:String(revision),epoch:'0',aftersales_epoch:String(groupEpoch),updated_at:'2026-11-06T00:00:00Z',device_name:'Test device'},error:null};
   assert.equal(name,'maya_apply_changes');
   if(receipts.has(args.p_request_id))return {data:{...receipts.get(args.p_request_id),status:'already_saved'},error:null};
   assert.equal(args.p_epoch,'0');assert.equal(args.p_aftersales_epoch,String(groupEpoch));
   for(const op of args.p_changes){
    if(op.kind==='replace_aftersales'){
     assert.deepEqual(op.expected.aftersalesRecords,cloud.aftersalesRecords);
     cloud.aftersalesRecords=structuredClone(op.value.aftersalesRecords);cloud.aftersalesHeaders=structuredClone(op.value.aftersalesHeaders);groupEpoch++;
    }else if(op.kind==='update'&&op.collection==='aftersalesRecords'){
     const row=cloud.aftersalesRecords.find(r=>String(r.id)===op.id);Object.assign(row,op.set);
    }else throw Error('Unexpected operation '+op.kind);
   }
   writes++;revision++;
   const data={status:'saved',request_id:args.p_request_id,revision:String(revision),epoch:'0',aftersales_epoch:String(groupEpoch),saved_at:new Date().toISOString(),device_name:args.p_device_name,skipped:[]};receipts.set(args.p_request_id,data);return {data,error:null};
  });
  await context.route('https://**/*',route=>{
   const url=route.request().url();
   if(url.includes('supabase-js'))return route.fulfill({contentType:'application/javascript',body:'window.supabase={createClient:()=>({rpc:(n,a)=>window.aftersalesRpc(n,a)})}'});
   if(url.includes('tailwind'))return route.fulfill({contentType:'application/javascript',body:`document.head.insertAdjacentHTML('beforeend','<style>'+${JSON.stringify(css)}+'</style>')`});
   if(url.includes('xlsx-js-style'))return route.fulfill({contentType:'application/javascript',body:bundle});
   return route.fulfill({body:''});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(process.env.MAYA_TEST_URL||'http://127.0.0.1:8000/',{waitUntil:'domcontentloaded',timeout:60000});await saved(page);await page.click('#tab-aftersales');return {context,page};
 }
 async function saved(page){try{await page.waitForFunction(()=>document.getElementById('sync-status').textContent==='All changes saved to cloud',null,{timeout:15000});}catch(error){console.error('Sync status:',await page.locator('#sync-status').innerText(),'Page errors:',errors);throw error;}}
 const cards=page=>page.locator('#aftersales-cards-container [data-action="set-status"][data-status="Resolved"]');
 async function exported(page,scope){
  await page.click('#export-aftersales-excel-btn');
  const done=page.waitForEvent('download');await page.click(`[data-aftersales-export="${scope}"]`);const download=await done;
  const buffer=fs.readFileSync(await download.path());const workbook=XLSX.read(buffer,{type:'buffer',cellStyles:true});return {buffer,workbook,name:download.suggestedFilename()};
 }
 async function upload(page,name,buffer){await page.locator('#aftersales-file-input').setInputFiles({name,mimeType:name.endsWith('.xls')?'application/vnd.ms-excel':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer});await page.locator('#confirm-modal').waitFor({state:'visible'});}
 const first=await device(),page=first.page;
 assert.equal(await page.locator('#aftersales-status-filter').innerText(),'Default');assert.equal(await cards(page).count(),2);
 await page.fill('#aftersales-search-input','CHOMART');assert.equal(await cards(page).count(),1);
 for(const mode of ['Resolved','Unresolved','Default']){await page.click('#aftersales-status-filter');assert.equal(await page.locator('#aftersales-status-filter').innerText(),mode);assert.equal(await cards(page).count(),1);assert.equal(await page.inputValue('#aftersales-search-input'),'CHOMART');}
 assert.equal(writes,0);console.log('PASS Default/Resolved/Unresolved intersect search and never cloud-save');
 await page.click('#aftersales-status-filter'); // Resolved
 const all=await exported(page,'all'),view=await exported(page,'view');
 assert.equal(all.name,filename);assert.equal(view.name,filename);
 const allSheet=all.workbook.Sheets[all.workbook.SheetNames[0]],viewSheet=view.workbook.Sheets[view.workbook.SheetNames[0]];
 assert.equal(A.parseSheet(XLSX,allSheet).rows.length,5);assert.equal(A.parseSheet(XLSX,viewSheet).rows.length,1);assert.equal(A.parseSheet(XLSX,viewSheet).rows[0].status,'Resolved');assert.equal(viewSheet['!cols'][headers.length].hidden,true);assert.deepEqual(A.parseSheet(XLSX,allSheet).headers,headers);
 console.log('PASS actual browser downloads support all/current-view, original names and hidden marker columns');
 await page.fill('#aftersales-search-input','NO MATCH');assert.match(await page.locator('#aftersales-cards-container').innerText(),/NO MATCHING RECORDS/);await page.click('#export-aftersales-excel-btn');assert.equal(await page.locator('[data-aftersales-export="view"]').isDisabled(),true);assert.equal(await page.locator('[data-aftersales-export="all"]').isEnabled(),true);await page.keyboard.press('Escape');await page.fill('#aftersales-search-input','CHOMART');
 await upload(page,filename,view.buffer);assert.match(await page.locator('#confirm-message').innerText(),/Replace all 5 .* with 1 records/);await page.click('#confirm-cancel-btn');assert.equal(writes,0);assert.equal(cloud.aftersalesRecords.length,5);
 await upload(page,filename,view.buffer);await page.click('#confirm-action-btn');await saved(page);assert.equal(cloud.aftersalesRecords.length,1);assert.equal(cloud.aftersalesRecords[0].status,'Resolved');assert.equal(cloud.aftersalesRecords[0]._sourceFileName,filename);
 await upload(page,filename,all.buffer);await page.click('#confirm-action-btn');await saved(page);assert.deepEqual(cloud.aftersalesRecords.map(r=>r.status),rows.map(r=>r[3]));assert.equal(cloud.aftersalesRecords.length,5);
 console.log('PASS subset upload cancellation is non-mutating; confirmed imports retain all exported marker states');
 const second=await device();const cross=await exported(second.page,'all');assert.equal(cross.name,filename);assert.equal(writes,2);console.log('PASS another browser reads the source filename from synchronized record metadata');
 await page.reload({waitUntil:'domcontentloaded',timeout:60000});await saved(page);await page.click('#tab-aftersales');assert.equal(await page.inputValue('#aftersales-search-input'),'CHOMART');assert.equal(await page.locator('#aftersales-status-filter').innerText(),'Default');assert.equal(await cards(page).count(),1);await page.click('#aftersales-status-filter');console.log('PASS reload restores the visible search text and defaults to unmarked');
 const legacyBook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(legacyBook,XLSX.utils.aoa_to_sheet([headers,['CHOMART','LEGACY ONE','L1'],['OTHER','LEGACY TWO','L2']]),'Legacy');
 const legacy=XLSX.write(legacyBook,{type:'buffer',bookType:'biff8'});
 await upload(page,'Legacy.xls',legacy);await page.click('#confirm-action-btn');await saved(page);assert.ok(cloud.aftersalesRecords.every(r=>r.status==='None'));
 const legacyOut=await exported(page,'all');assert.equal(legacyOut.name,'Legacy.xlsx');
 await page.click('#aftersales-status-filter');await page.click('#aftersales-status-filter'); // Default
 await page.fill('#aftersales-search-input','');assert.equal(await cards(page).count(),2);
 await cards(page).first().click();await saved(page);assert.equal(await cards(page).count(),1);assert.equal(cloud.aftersalesRecords.filter(r=>r.status==='Resolved').length,1);assert.ok(cloud.aftersalesRecords.every(r=>r._sourceFileName==='Legacy.xls'));
 console.log('PASS legacy XLS import defaults to unmarked, XLSX extension is correct, and marking still works under the filter');
 const malformed=XLSX.utils.book_new();XLSX.utils.book_append_sheet(malformed,XLSX.utils.aoa_to_sheet([['Same','Same'],['1','2']]),'Bad');
 const before=writes;await page.locator('#aftersales-file-input').setInputFiles({name:'Bad.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(malformed,{type:'buffer',bookType:'xlsx'})});await page.waitForFunction(()=>document.getElementById('toast-message-span').textContent.includes('Duplicate column'));assert.equal(writes,before);
 for(const width of [320,390]){await page.setViewportSize({width,height:844});await page.click('#export-aftersales-excel-btn');const bounds=await page.locator('#aftersales-export-menu').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.screenshot({path:'/tmp/maya-aftersales-phone.png'});assert.deepEqual(errors,[]);console.log('PASS malformed files leave data unchanged; menu fits phones; no page errors or live database calls');
}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
