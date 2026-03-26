/**
 * HTTP MCP server for agent-to-agent delegation.
 * Exposes delegate_to_agent and list_agents tools so any agent
 * can call another agent and get its response.
 */
const { createMcpHttpServer } = require('./mcp-http-server');

const TOOLS = [
  {
    name: 'delegate_to_agent',
    description: 'Delegate a task to another agent. The agent runs to completion and returns its response. Use list_agents first to see available agent IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'Agent ID to delegate to (e.g. "dev", "QA-Browser", "QA"). Use list_agents to see available IDs.',
        },
        message: {
          type: 'string',
          description: 'The task instruction for the agent. Be specific — this is the only thing the agent sees.',
        },
      },
      required: ['agent_id', 'message'],
    },
  },
  {
    name: 'list_agents',
    description: 'List all available agents you can delegate tasks to, with their IDs and descriptions.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Start the agent delegation MCP HTTP server.
 * @param {object} options
 * @param {(agentId: string, message: string) => Promise<string>} options.onDelegate
 * @param {() => Promise<string>} options.onListAgents
 * @returns {Promise<{port: number, server: object, close: function}>}
 */
async function startAgentDelegateMcpServer({ onDelegate, onListAgents }) {
  return createMcpHttpServer({
    tools: TOOLS,
    handleToolCall: async (name, args) => {
      if (name === 'delegate_to_agent') {
        return await onDelegate(args.agent_id, args.message);
      }
      if (name === 'list_agents') {
        return await onListAgents();
      }
      return 'Unknown tool: ' + name;
    },
    serverName: 'cc-agent-delegate',
  });
}

module.exports = { startAgentDelegateMcpServer };
