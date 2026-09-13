const fs = require('node:fs');

// The parent maps this extra pipe to child.stdin. Unlike standard descriptors,
// fd 3 really closes on Windows, while the child and its stdout remain alive.
module.exports = function closeStdin(ready) {
  fs.closeSync(3);
  ready();
};
