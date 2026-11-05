/* New full25 policy projection; preserves earlier full/peer pinned dependencies. */
'use strict';
module.exports = { ...require('./codex-full-oracle.cjs'), ...require('./codex-full-readonly-oracle.cjs'), ...require('./codex-full-readonly-probe.cjs') };
