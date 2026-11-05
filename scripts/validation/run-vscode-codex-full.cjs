'use strict';
require('./ordinary-profile-runner.cjs').runOwnedEditor({
  caseId: 'PB-02', envPrefix: 'MYSTI_PB02_FULL', suiteStem: 'codex-full',
  label: '[PB-02 ordinary Codex full25]', plannedInputs: 29, timeoutMs: 3450000,
});
