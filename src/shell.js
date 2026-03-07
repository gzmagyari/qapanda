const readline = require('node:readline/promises');
const path = require('node:path');

const { Renderer } = require('./render');
const { printEventTail, printRunSummary, runManagerLoop } = require('./orchestrator');
const {
  defaultStateRoot,
  listRunManifests,
  loadManifestFromDir,
  prepareNewRun,
  resolveRunDir,
  saveManifest,
} = require('./state');
const { summarizeError } = require('./utils');

function parseCommand(line) {
  const trimmed = String(line || '').trim();
  const space = trimmed.indexOf(' ');
  if (space === -1) {
    return { command: trimmed, rest: '' };
  }
  return {
    command: trimmed.slice(0, space),
    rest: trimmed.slice(space + 1).trim(),
  };
}

function printHelp(renderer) {
  renderer.banner(`
Commands:
  /help                Show this help
  /new <message>       Start a new run and send the first user message
  /resume <run-id>     Attach to an existing run
  /use <run-id>        Alias for /resume
  /run                 Continue an interrupted request in the attached run
  /status              Show status for the attached run
  /list                List saved runs
  /logs [n]            Show the last n event lines for the attached run
  /detach              Detach from the current run
  /quit                Exit the shell

Plain text:
  - If no run is attached, plain text starts a new run.
  - If a run is attached, plain text becomes the next user message for that run.
`);
}

async function runInteractiveShell(options = {}) {
  const cwd = path.resolve(options.repoRoot || process.cwd());
  const stateRoot = path.resolve(options.stateRoot || defaultStateRoot(cwd));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const renderer = new Renderer({ rawEvents: Boolean(options.rawEvents), quiet: false });

  let activeManifest = null;

  renderer.banner('cc-manager interactive shell');
  renderer.banner(`State root: ${stateRoot}`);
  renderer.banner('Type /help for commands.');

  try {
    while (true) {
      const prompt = renderer.userPrompt();
      let line;
      try {
        line = await rl.question(prompt);
      } catch (error) {
        if (error && error.code === 'ERR_USE_AFTER_CLOSE') {
          break;
        }
        throw error;
      }
      const trimmed = String(line || '').trim();
      if (!trimmed) {
        continue;
      }

      if (trimmed.startsWith('/')) {
        const { command, rest } = parseCommand(trimmed);
        if (command === '/quit' || command === '/exit') {
          break;
        }
        if (command === '/help') {
          printHelp(renderer);
          continue;
        }
        if (command === '/detach') {
          activeManifest = null;
          renderer.banner('Detached from the current run.');
          continue;
        }
        if (command === '/list') {
          const manifests = await listRunManifests(stateRoot);
          if (manifests.length === 0) {
            renderer.banner('No runs found.');
          } else {
            for (const manifest of manifests) {
              renderer.banner(`${manifest.runId} | ${manifest.status} | ${manifest.transcriptSummary || ''}`);
            }
          }
          continue;
        }
        if (command === '/resume' || command === '/use') {
          if (!rest) {
            renderer.banner('Usage: /resume <run-id>');
            continue;
          }
          const runDir = await resolveRunDir(rest, stateRoot);
          activeManifest = await loadManifestFromDir(runDir);
          renderer.requestStarted(activeManifest.runId);
          continue;
        }
        if (command === '/status') {
          if (!activeManifest) {
            renderer.banner('No run is attached.');
            continue;
          }
          await printRunSummary(activeManifest);
          continue;
        }
        if (command === '/logs') {
          if (!activeManifest) {
            renderer.banner('No run is attached.');
            continue;
          }
          const tail = rest ? Number.parseInt(rest, 10) || 40 : 40;
          await printEventTail(activeManifest, tail);
          continue;
        }
        if (command === '/run') {
          if (!activeManifest) {
            renderer.banner('No run is attached.');
            continue;
          }
          try {
            activeManifest = await runManagerLoop(activeManifest, renderer, {});
            await saveManifest(activeManifest);
          } catch (error) {
            renderer.banner(`Run error: ${summarizeError(error)}`);
          } finally {
            renderer.close();
          }
          continue;
        }
        if (command === '/new') {
          if (!rest) {
            renderer.banner('Usage: /new <message>');
            continue;
          }
          activeManifest = await prepareNewRun(rest, { ...options, repoRoot: cwd, stateRoot });
          renderer.requestStarted(activeManifest.runId);
          try {
            activeManifest = await runManagerLoop(activeManifest, renderer, { userMessage: rest });
          } catch (error) {
            renderer.banner(`Run error: ${summarizeError(error)}`);
          } finally {
            renderer.close();
          }
          continue;
        }

        renderer.banner(`Unknown command: ${command}`);
        continue;
      }

      try {
        if (!activeManifest) {
          activeManifest = await prepareNewRun(trimmed, { ...options, repoRoot: cwd, stateRoot });
        }
        activeManifest = await runManagerLoop(activeManifest, renderer, { userMessage: trimmed });
      } catch (error) {
        renderer.banner(`Run error: ${summarizeError(error)}`);
      } finally {
        renderer.close();
      }
    }
  } finally {
    rl.close();
  }
}

module.exports = {
  runInteractiveShell,
};
