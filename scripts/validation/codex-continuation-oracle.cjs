/* New remaining14 contracts; earlier pinned modules stay unchanged. */
'use strict';
module.exports = { ...require('./codex-full-oracle.cjs'), ...require('./codex-full-readonly-oracle.cjs'), ...require('./codex-full-readonly-probe.cjs'), ...require('./codex-continuation-contract.cjs') };
