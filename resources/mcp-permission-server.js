#!/usr/bin/env node

/**
 * MCP Permission Server Wrapper
 *
 * This script is executed by Claude CLI when using --permission-prompt-tool.
 * It requires the compiled MCP server module and the MYSTI_PERMISSION_PORT
 * environment variable to be set by the VSCode extension.
 */

const path = require('path');

// The compiled TypeScript will be in dist/
const serverPath = path.join(__dirname, '..', 'dist', 'mcp', 'permissionServer.js');

try {
  require(serverPath);
} catch (error) {
  console.error('[MCP Wrapper] Failed to load permission server:', error);
  process.exit(1);
}
