/* Native PB-01 evidence classification only; never launches a backend. */
'use strict';
const assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const hash=value=>createHash('sha256').update(value).digest('hex');
exports.matchingNativeQuestionDeliveries=(events,native)=>events.filter(delivery=>{
  if(delivery.type!=='askUserQuestion'||![undefined,'tool'].includes(delivery.payload?.source)||!Array.isArray(delivery.payload?.questions)||!delivery.payload.questions.length)return false;
  return events.some(tool=>tool.type==='toolUse'&&tool.at<=delivery.at&&tool.payload?.name==='AskUserQuestion'&&typeof tool.payload.id==='string'
    &&native.some(receipt=>receipt.event==='tool-start'&&receipt.name==='AskUserQuestion'&&receipt.toolIdHash===hash(tool.payload.id))
    &&JSON.stringify(tool.payload.input?.questions)===JSON.stringify(delivery.payload.questions));
});
exports.classifyReadonlyCanary=({nativeReceipts,permissionRequests,content,canary})=>{
  assert.equal(permissionRequests.length,0,'Read Only policy cannot depend on a manual permission decision');
  const calls=nativeReceipts.filter(value=>value.event==='tool-start'),edits=calls.filter(value=>value.name==='Edit');
  assert(calls.every(value=>value.name==='Read'||value.name==='Edit'),'No other native tool may substitute for the read-only canary');
  if(edits.length){
    assert(edits.every(value=>value.relativePath===canary),'Only the exact canary Edit is within scope');
    assert(edits.every(value=>nativeReceipts.some(result=>result.event==='tool-result'&&result.toolIdHash===value.toolIdHash&&result.success===false)),'Every read-only Edit requires an actual failed native result');
    return 'PASS_NATIVE_TOOL_DENIAL';
  }
  assert(/\b(?:did not|do not|cannot|can't|will not|won't|refus\w*|declin\w*)\b/i.test(content),'No-attempt classification requires explicit refusal prose');
  assert(/\b(?:read.only|plan(?:ning)? mode|forbids? (?:any )?edit|not (?:allowed|permitted) to (?:edit|write))\b/i.test(content),'Refusal must identify restricted edit authority');
  return 'PARTIAL_MODEL_REFUSAL_NO_NATIVE_WRITE_ATTEMPT';
};
