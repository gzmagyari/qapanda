const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

test('direct runs fall back to a writable temp state root when repo-local .qpanda is read-only', async () => {
  const cliPath = require.resolve('../../src/cli');
  const originalLoad = Module._load;
  const repoRoot = path.resolve('/workspace/qapanda');
  const defaultStateRoot = path.resolve(repoRoot, '.qpanda');
  const fallbackTmpRoot = '/tmp/qapanda-state-test';
  const captured = { prepareOptions: null };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && parent.filename === cliPath) {
      if (request === 'node:fs/promises') {
        return {
          mkdir: async (targetPath) => {
            const normalized = String(targetPath).replace(/\\/g, '/');
            if (normalized.startsWith(defaultStateRoot.replace(/\\/g, '/') + '/.state-probe-')) {
              const error = new Error('read-only');
              error.code = 'EROFS';
              throw error;
            }
          },
          rm: async () => {},
        };
      }
      if (request === 'node:os') {
        return { tmpdir: () => fallbackTmpRoot };
      }
      if (request === './feature-flags') {
        return { loadFeatureFlags: () => ({ enableClaudeCli: false, enableRemoteDesktop: false, enablePersonalWorkspaces: false }) };
      }
      if (request === './process-utils') {
        return { execForText: async () => ({ code: 0, stdout: 'ok', stderr: '' }) };
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
            throw new Error('runManagerLoop should not be called');
          },
          runDirectWorkerTurn: async (manifest) => manifest,
        };
      }
      if (request === './state') {
        return {
          defaultStateRoot: () => defaultStateRoot,
          listRunManifests: async () => [],
          loadManifestFromDir: async () => null,
          lookupAgentConfig: (agents, id) => agents[id] || null,
          prepareNewRun: async (_message, options) => {
            captured.prepareOptions = { ...options };
            return {
              runId: 'run-state-fallback',
              repoRoot: options.repoRoot,
              stateRoot: options.stateRoot,
              runDir: path.join(options.stateRoot, 'runs', 'run-state-fallback'),
              files: {
                manifest: path.join(options.stateRoot, 'runs', 'run-state-fallback', 'manifest.json'),
                events: path.join(options.stateRoot, 'runs', 'run-state-fallback', 'events.jsonl'),
                transcript: path.join(options.stateRoot, 'runs', 'run-state-fallback', 'transcript.jsonl'),
                chatLog: path.join(options.stateRoot, 'runs', 'run-state-fallback', 'chat.jsonl'),
                progress: path.join(options.stateRoot, 'runs', 'run-state-fallback', 'progress.md'),
              },
              settings: { rawEvents: false, quiet: true },
              controller: { cli: options.controllerCli || 'codex' },
              worker: { cli: options.workerCli || 'codex', sessionId: 'worker-1' },
              agents: options.agents || {},
              requests: [],
              status: 'idle',
            };
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
          createRepoRootDescriptor: () => ({
            kind: 'repo',
            repoRoot,
            stateRoot: defaultStateRoot,
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
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[cliPath];
  try {
    const { main } = require('../../src/cli');
    await main(['run', '--agent', 'QA-Browser', '--no-chrome', 'Check the login page.']);
    assert.ok(captured.prepareOptions, 'prepareNewRun should have been called');
    assert.equal(
      captured.prepareOptions.stateRoot,
      path.join(fallbackTmpRoot, 'qapanda-state', 'qapanda'),
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[cliPath];
  }
});
