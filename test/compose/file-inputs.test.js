'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Y=require('../../src/vendor/yaml/dist');const {audit}=require('../../src/compose/audit');
for(const field of ['env_file','label_file']){
  for(const [label,value] of [['short','./never-read.txt'],['list',['./never-read.txt']],['invalid-null',null],['invalid-number',42],['invalid-empty','']]){
    test(`unanalysed ${field}: ${label}`,()=>{
      const r=audit(Y.stringify({services:{web:{[field]:value}}}));
      assert.equal(r.exitCode,3);assert.equal(r.analysisStatus,'incomplete');assert.equal(r.riskStatus,'no-findings');
      assert.equal(r.summary.active,0);assert.equal(r.summary.limitations,1);
      assert.equal(r.findings[0].evidence.field,field);assert.equal(r.findings[0].evidence.contents,'not-read');
      assert.ok(!JSON.stringify(r).includes('never-read.txt'));
    });
  }
  test(`${field}: absent and empty list are safe neighboring cases`,()=>{
    for(const cfg of [{},{[field]:[]}])assert.equal(audit(Y.stringify({services:{web:cfg}})).exitCode,0);
  });
  test(`${field}: literal evidence survives unresolved sibling and suppression`,()=>{
    const r=audit(Y.stringify({services:{Web:{[field]:['./never-read.txt','${EXTRA_FILE}'],cap_add:['SYS_ADMIN'],privileged:true}}}),
      {policy:{schemaVersion:1,suppressions:[{ruleId:'CXR-002',service:'Web',reason:'Reviewed synthetic fixture'}]}});
    assert.equal(r.exitCode,3);assert.equal(r.summary.limitations,2);assert.equal(r.summary.active,1);assert.equal(r.summary.suppressed,1);
    assert.ok(r.findings.some(f=>f.ruleId==='CXR-005'));assert.ok(r.findings.some(f=>f.evidence.contents==='not-read'));
  });
}
for(const [label,value,kind] of [
  ['optional raw',[{path:'./never-read.env',required:false,format:'raw'}],'unanalysed-file-input'],
  ['unknown option',[{path:'./never-read.env',future:true}],'invalid-file-input'],
  ['invalid required',[{path:'./never-read.env',required:'false'}],'invalid-file-input'],
  ['mapping outside list',{path:'./never-read.env'},'invalid-file-input']
])test('env_file long syntax: '+label,()=>{
  const r=audit(Y.stringify({services:{web:{env_file:value}}}));assert.equal(r.exitCode,3);assert.equal(r.findings[0].evidence.kind,kind);
});
