'use strict';
require('./ordinary-profile-runner.cjs').runOwnedEditor({
  caseId: 'PB-02', envPrefix: 'MYSTI_PB02', suiteStem: 'codex',
  label: '[PB-02 ordinary Codex stage one]', plannedInputs: 10, timeoutMs: 1650000,
});
