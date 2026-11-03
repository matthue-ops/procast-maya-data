const {chromium}=require('playwright');const fs=require('node:fs');const assert=require('node:assert/strict');
(async()=>{
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const css=fs.readFileSync(process.env.MAYA_TEST_CSS || '/tmp/maya-test-styles.css','utf8');const fixture=require('./merge-fixture.cjs');
 await page.route('https://**/*',route=>{
  const url=route.request().url();
  if(url.includes('supabase-js'))return route.fulfill({contentType:'application/javascript',body:`window.supabase={createClient:()=>({rpc:async name=>{if(!['maya_read_state','maya_sync_status'].includes(name))throw Error('Unexpected write');return {data:{protocol:2,revision:'0',epoch:'0',aftersales_epoch:'0',updated_at:'2026-11-03T00:00:00Z',payload:${JSON.stringify(fixture)}},error:null}}})}`});
  if(url.includes('tailwind'))return route.fulfill({contentType:'application/javascript',body:`document.head.insertAdjacentHTML('beforeend','<style>'+${JSON.stringify(css)}+'</style>')`});
  if(url.includes('xlsx'))return route.fulfill({contentType:'application/javascript',body:'window.XLSX={}'});
  return route.fulfill({body:''});
 });
 await page.goto('http://127.0.0.1:8000/');await page.waitForFunction(()=>document.getElementById('sync-status').textContent==='All changes saved to cloud');
 for(const width of [320,390]){
  await page.setViewportSize({width,height:844});
  const theme=await page.locator('#theme-toggle-btn').boundingBox(),tabs=await page.locator('#tab-collection').boundingBox();
  assert.ok(theme.y+theme.height<=tabs.y+1,'Theme control overlaps tabs');
  assert.ok((await page.locator('#search-input').boundingBox()).y<500);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.click('#new-record-btn');assert.ok((await page.locator('#new-establishment-name').boundingBox()).height>=44);await page.click('#close-create-record-btn');
  console.log('PASS phone layout',width,'px: no overlap/overflow, search near top, touch-sized form');
 }
 assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/maya-v2-phone-final.png'});
}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
