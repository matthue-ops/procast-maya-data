module.exports = {
 customFields:[{key:'ADDRESS',type:'text'},{key:'PHONE',type:'text'}],
 establishments:[{id:'r1',name:'CLIENT A',details:{ADDRESS:'Old',PHONE:'0'}},{id:'r2',name:'CLIENT B',details:{ADDRESS:'B',PHONE:'2'}}],
 savedFilters:[{id:'f1',name:'ADDRESS VIEW',fields:['ADDRESS','PHONE']}],
 aftersalesHeaders:['Merchant'],
 aftersalesRecords:[{id:'a1',merchantName:'Merchant',dbaName:'DBA',status:'None',details:{Merchant:'Merchant'}}]
};
