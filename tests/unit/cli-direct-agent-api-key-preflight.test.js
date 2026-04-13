const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

test('direct QA-Browser runs fail early with a clear missing API key message', async () => {
  const cliPath = require.resolve('../../src/cli');
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && parent.filename === cliPath) {
      if (request === './feature-flags') {
        return { loadFeatureFlags: () => ({ enableClaudeCli: false, enableRemoteDesktop: false, enablePersonalWorkspaces: false }) };
      }
      if (request === './process-utils') {
        return {
          execForText: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
        };
      }
      if (request === './render') {
        return {
          Renderer: class Renderer {
            requestStarted() {}
            close() {}
          },
        };
      }
      if (request === './orchestrator') {
        return {
          printEventTail: async () => {},
          printRunSummary: async () => {},
          runManagerLoop: async () => {
            throw new Error('runManagerLoop should not be called for direct agent runs');
          },
          runDirectWorkerTurn: async () => {
            throw new Error('runDirectWorkerTurn should not execute when API key preflight fails');
          },
        };
      }
      if (request === './state') {
        return {
          defaultStateRoot: () => path.join(process.cwd(), '.qpanda'),
          listRunManifests: async () => [],
          loadManifestFromDir: async () => null,
          lookupAgentConfig: (agents, id) => agents[id] || null,
          prepareNewRun: async () => {
            throw new Error('prepareNewRun should not execute when API key preflight fails');
          },
          resolveRunDir: async () => null,
          saveManifest: async () => {},
        };
      }
      if (request === './utils') {
        return {
          parseInteger: (value) => (value == null ? null : Number.parseInt(value, 10)),
          parseNumber: (value) => (value == null ? null : Number(value)),
          readAllStdin: async () => '',
        };
      }
      if (request === './shell') return { runInteractiveShell: async () => {} };
      if (request === './external-chat-discovery') return { discoverExternalChatSessions: async () => [] };
      if (request === './external-chat-import') return { importExternalChatSession: async () => {} };
      if (request === './external-chat-search') return { searchExternalChatSessions: async () => [] };
      if (request === './config-loader') {
        return {
          findResourcesDir: () => null,
          loadMergedAgents: () => ({
            'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'api', mcps: { 'chrome-devtools': { command: 'npx', args: [] } }, enabled: true },
          }),
          loadMergedModes: () => ({}),
          loadMergedMcpServers: () => ({ global: {}, project: {} }),
          enabledAgents: (agents) => agents,
          enabledModes: (modes) => modes,
          resolveByEnv: (value) => value,
          getCliDefaults: () => ({ controllerCli: 'codex', workerCli: 'codex' }),
          loadOnboarding: () => null,
          isOnboardingComplete: () => true,
        };
      }
      if (request === './mcp-injector') return { mcpServersForRole: () => ({}) };
      if (request === './named-workspaces') {
        return {
          bindResumeAlias: async () => {},
          createRepoRootDescriptor: (repoRoot) => ({
            kind: 'repo',
            repoRoot,
            stateRoot: path.join(repoRoot, '.qpanda'),
            workspaceName: null,
            rootIdentity: repoRoot,
          }),
          ensureNamedWorkspace: async () => {
            throw new Error('named workspaces should not be used in this test');
          },
          resolveResumeToken: async () => null,
        };
      }
      if (request === './cloud') return { createCloudBoundary: () => ({ preload: async () => {} }) };
      if (request === './cloud/cli-auth') return { runCloudCommand: async () => {}, CLOUD_COMMAND_USAGE: '' };
      if (request === './mcp-tool-bridge') return { closeAll: async () => {} };
      if (request === './cloud/workflow-hosted-runs') {
        return {
          createHostedWorkflowRedactor: () => null,
          materializeHostedWorkflowRun: async () => null,
          redactHostedWorkflowValue: (value) => value,
          sanitizeHostedWorkflowCloudRunSpec: (value) => value,
          setHostedWorkflowExecutionContext: () => {},
        };
      }
      if (request === './cloud-run') {
        return {
          CLOUD_RUN_ARG_SPEC: {},
          buildDirectCloudRunPrompt: () => '',
          buildCloudRunOptions: () => ({}),
          createCloudRunEventBridge: () => () => {},
          detectCloudRunExecutionIssue: () => null,
          emitCloudRunRawEvent: () => {},
          loadCloudRunSpec: () => ({}),
          writeCloudRunArtifacts: async () => {},
        };
      }
      if (request === './api-provider-registry') {
        return {
          resolveRuntimeApiProvider: () => ({
            id: 'openrouter',
            clientProvider: 'openrouter',
            envKey: 'OPENROUTER_API_KEY',
          }),
        };
      }
      if (request === './llm-client') {
        return {
          resolveApiKey: () => '',
        };
      }
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[cliPath];
  try {
    const { main } = require('../../src/cli');
    await assert.rejects(
      () => main(['run', '--agent', 'QA-Browser', '--no-chrome', 'Check the login page.']),
      /Missing API key for provider "openrouter" used by direct agent "QA-Browser"/,
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[cliPath];
  }
});
