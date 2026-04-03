const MCP_STARTUP_TIMEOUT_SEC = 30;
const AGENT_DELEGATE_TOOL_TIMEOUT_SEC = 600;

function mcpToolTimeoutSec(serverName) {
  if (serverName === 'cc-agent-delegate') {
    return AGENT_DELEGATE_TOOL_TIMEOUT_SEC;
  }
  return null;
}

module.exports = {
  MCP_STARTUP_TIMEOUT_SEC,
  AGENT_DELEGATE_TOOL_TIMEOUT_SEC,
  mcpToolTimeoutSec,
};
