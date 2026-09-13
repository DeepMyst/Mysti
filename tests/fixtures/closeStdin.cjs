const fs = require('node:fs');

// libuv duplicates Windows standard handles. Close both the CRT descriptor and
// the stream handle before announcing readiness; stdout remains open.
module.exports = function closeStdin(ready) {
  if (process.platform === 'win32') {
    const input = process.stdin;
    input.once('close', ready);
    fs.closeSync(0);
    input.destroy();
  } else {
    // Avoid creating a libuv handle for fd 0 on POSIX.
    fs.closeSync(0);
    ready();
  }
};
