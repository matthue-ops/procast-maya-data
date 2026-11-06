const assert=require('node:assert/strict');
const XLSX=require(process.env.MAYA_XLSX_MODULE||'/tmp/maya-excel-tests/node_modules/xlsx-js-style');
const A=require('../aftersales-workbook.js');
const headers=['OWNER','Merchant Name','DBA Name'];
const records=[
 {id:'n',merchantName:'Merchant A',dbaName:'A',details:{OWNER:'CHOMART','Merchant Name':'Merchant A','DBA Name':'A'},status:'None',_sourceFileName:'Field Report November.xlsx'},
 {id:'r',merchantName:'Merchant B',dbaName:'B',details:{OWNER:'CHOMART','Merchant Name':'Merchant B','DBA Name':'B'},status:'Resolved',_sourceFileName:'Field Report November.xlsx'},
 {id:'u',merchantName:'Merchant C',dbaName:'C',details:{OWNER:'CHOMART','Merchant Name':'Merchant C','DBA Name':'C'},status:'Unresolved',_sourceFileName:'Field Report November.xlsx'},
 {id:'other',merchantName:'Other',dbaName:'D',details:{OWNER:'OTHER','Merchant Name':'Other','DBA Name':'D'},status:'None',_sourceFileName:'Field Report November.xlsx'}
];
for(const status of ['None','Resolved','Unresolved'])assert.equal(A.filtered(records,'CHOMART',status).length,1);
assert.equal(A.filtered(records,'not found','None').length,0);assert.equal(A.filtered(records,'Field Report November','None').length,0);
console.log('PASS search and status intersect without searching source-file metadata');
const workbook=A.makeWorkbook(XLSX,headers,records);
const buffer=XLSX.write(workbook,{type:'buffer',bookType:'xlsx'});
const reread=XLSX.read(buffer,{type:'buffer',cellStyles:true});const sheet=reread.Sheets[reread.SheetNames[0]];
assert.equal(sheet['!cols'][headers.length].hidden,true);
const parsed=A.parseSheet(XLSX,sheet);assert.deepEqual(parsed.headers,headers);assert.deepEqual(parsed.rows.map(r=>r.status),records.map(r=>r.status));assert.deepEqual(parsed.rows.map(r=>r.details),records.map(r=>r.details));
assert.equal(workbook.Sheets[workbook.SheetNames[0]].A3.s.fill.fgColor.rgb.slice(-6),'D1FAE5');
assert.equal(workbook.Sheets[workbook.SheetNames[0]].A4.s.fill.fgColor.rgb.slice(-6),'FEE2E2');
console.log('PASS real XLSX round-trip retains markers, hides their column, and preserves visible data/colors');
const subset=A.filtered(records,'CHOMART','Resolved');const subsetBook=A.makeWorkbook(XLSX,headers,subset);
const subsetSheet=subsetBook.Sheets[subsetBook.SheetNames[0]];assert.equal(A.parseSheet(XLSX,subsetSheet).rows.length,1);assert.equal(A.parseSheet(XLSX,subsetSheet).rows[0].status,'Resolved');
assert.equal(A.exportFilename(records),'Field Report November.xlsx');assert.equal(A.filename('Legacy.XLS'),'Legacy.xlsx');assert.equal(A.exportFilename([{_sourceFileName:'One.xlsx'},{_sourceFileName:'Two.xlsx'}]),A.FALLBACK);assert.equal(A.exportFilename([{}]),A.FALLBACK);
console.log('PASS current-view subset and source filename rules');
const legacy=XLSX.utils.aoa_to_sheet([['OWNER','','Merchant Name','Status'],['CHOMART','ignored','Shift-safe','Resolved']]);
const legacyParsed=A.parseSheet(XLSX,legacy);assert.deepEqual(legacyParsed.headers,['OWNER','Merchant Name','Status']);assert.equal(legacyParsed.rows[0].details['Merchant Name'],'Shift-safe');assert.equal(legacyParsed.rows[0].status,'None');
const invalid=XLSX.utils.aoa_to_sheet([['Name',A.MARKER],['A','bad'],['B',' unmarked '],['C',' resolved '],['D','Unresolved']]);
assert.deepEqual(A.parseSheet(XLSX,invalid).rows.map(r=>r.status),['None','None','Resolved','Unresolved']);
assert.throws(()=>A.parseSheet(XLSX,XLSX.utils.aoa_to_sheet([['Name','Name'],['A','B']])) ,/Duplicate column/);
assert.throws(()=>A.parseSheet(XLSX,XLSX.utils.aoa_to_sheet([['Name',A.MARKER,A.MARKER],['A','Resolved','None']])) ,/Duplicate hidden/);
const falsy=A.makeWorkbook(XLSX,['Zero','Boolean'],[{details:{Zero:0,Boolean:false},status:'None'}]);
assert.equal(A.parseSheet(XLSX,falsy.Sheets[falsy.SheetNames[0]]).rows[0].details.Zero,'0');assert.equal(A.parseSheet(XLSX,falsy.Sheets[falsy.SheetNames[0]]).rows[0].details.Boolean,'false');
console.log('PASS legacy/invalid markers, blank headers, duplicate rejection, and zero/false values');
