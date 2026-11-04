const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const fixture=require('./merge-fixture.cjs');
const container=process.env.MAYA_TEST_CONTAINER || 'maya-merge-test';
if(!/^[a-z0-9-]*test$/.test(container)) throw Error('Use a disposable container whose name ends in test');
const database=process.env.MAYA_TEST_DATABASE || 'postgres';
const quote=value=>"'"+String(value).replace(/'/g,"''")+"'";
function sql(query){return new Promise((resolve,reject)=>{
 const env={...process.env}; for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[key];
 const child=spawn('docker',['--host=unix:///var/run/docker.sock','exec','-i',container,'psql','-U','postgres','-d',database,'-qAt','-v','ON_ERROR_STOP=1'],{env});
 let out='',err='';child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);child.on('error',reject);
 child.on('close',code=>code?reject(Error(err)):resolve(out.trim()));child.stdin.end(query);
});}
async function rpc(name,args={},role='anon'){
 let query;
 if(name==='maya_read_state')query='SELECT public.maya_read_state();';
 else if(name==='maya_sync_status')query='SELECT public.maya_sync_status();';
 else if(name==='maya_apply_changes'){
  if(!/^\d+$/.test(args.p_epoch)||!/^\d+$/.test(args.p_aftersales_epoch))throw Error('Invalid test epoch');
  query=`SELECT public.maya_apply_changes(${quote(args.p_request_id)}::uuid,${args.p_epoch}::bigint,${args.p_aftersales_epoch}::bigint,${quote(JSON.stringify(args.p_changes))}::jsonb,${quote(args.p_device_name)});`;
 }else throw Error('Unexpected RPC '+name);
 return JSON.parse(await sql(`SET ROLE ${role==='authenticated'?'authenticated':'anon'}; ${query}`));
}
function request(changes,extra={}){return {p_request_id:randomUUID(),p_epoch:'0',p_aftersales_epoch:'0',p_device_name:'Test Phone',p_changes:changes,...extra};}
function update(id,details={},set={},collection='establishments'){return {kind:'update',collection,id,set,unset:[],details_set:details,details_unset:[]};}
async function reset(){await sql(`TRUNCATE public.maya_merge_receipts,public.maya_change_history,public.maya_deleted_items; UPDATE public.app_state SET payload=${quote(JSON.stringify(fixture))}::jsonb,sync_revision=0,sync_epoch=0,aftersales_epoch=0,updated_at=now() WHERE id='main_data';`);}
module.exports={sql,rpc,request,update,reset,fixture};
