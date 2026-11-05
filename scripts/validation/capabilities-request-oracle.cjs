/* Shared acceptance condition, exercised by synthetic red/green controls. */
'use strict';
const assert = require('node:assert/strict');
exports.assertClaudePeerHandoff = ({ request, content, handoffToken }) => {
  assert.equal(request.provider, 'claude-code');
  assert.equal(request.policy?.nativeResumeSupplied, true, 'Return must retain Claude native resume');
  assert(request.markerOrigins?.outsideProjectMemoryMarkers?.includes('COPILOT_AUTO_READ'), 'Native return must receive intervening peer turn outside project memory');
  assert.equal(request.containsHandoffToken, true, 'Native return must receive peer-only review tag');
  assert.equal(request.markerOrigins?.outsideProjectMemoryContainsHandoffToken, true, 'Review tag must arrive outside project memory');
  assert(typeof handoffToken === 'string' && /^PC12_REVIEW_[a-f0-9]{20}$/.test(handoffToken));
  assert(content.includes(handoffToken), 'Returned Claude must quote the review tag introduced only to Copilot');
};
exports.assertCopilotPromptHistoryRequest = request => {
  assert.equal(request.provider, 'github-copilot');
  assert.equal(request.sessionHash, undefined, 'Copilot prompt-history must not forward a native resume session');
  assert.equal(request.policy?.nativeResumeSupplied, false, 'Copilot prompt-history must omit every --resume form');
};
exports.matchesPublicModelSelection = ({expectedProvider,expectedModel,selection,inlineValue,customInputValue}) => {
  if (!selection || selection.provider !== expectedProvider) return false;
  const effective = selection.customModel || selection.model;
  if (effective !== expectedModel) return false;
  if (selection.customModel && customInputValue !== expectedModel) return false;
  return inlineValue === expectedModel || (inlineValue === '__custom__' && customInputValue === expectedModel);
};
exports.assertUnavailableCopilotModelAttempt = ({request,expectedModel,errorText,nativeReceipts}) => {
  exports.assertCopilotPromptHistoryRequest(request);
  assert.equal(request.model,expectedModel);
  assert.equal(request.policy.effort,'low');
  assert.deepEqual(request.policy.denyTools.slice().sort(),['shell','write']);
  assert.equal(request.policy.allowAllTools,false);
  assert.equal(errorText.trim(),`Error: Model "${expectedModel}" from --model flag is not available.`);
  assert(!nativeReceipts.some(value=>['model-call','auto-model-resolved','tool-start','tool-result'].includes(value.event)),'Rejected explicit attempt must have no model-call or tool receipt');
  assert(nativeReceipts.some(value=>value.event==='exit'&&value.exitCode===1),'Unavailable model must have its actual failed CLI exit');
};
