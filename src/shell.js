const fs = require('node:fs');
const readline = require('node:readline/promises');
const path = require('node:path');

const { Renderer } = require('./render');
const { printEventTail, printRunSummary, runManagerLoop } = require('./orchestrator');
const { loadWorkflows } = require('./prompts');
const {
  WAIT_OPTIONS,
  defaultStateRoot,
  formatWaitDelay,
  listRunManifests,
  loadManifestFromDir,
  parseWaitDelay,
  prepareNewRun,
  resolveRunDir,
  saveManifest,
} = require('./state');
const { summarizeError } = require('./utils');

const ERROR_RETRY_DELAY_MS = 30 * 60_000; // 30 minutes

function isAbortError(error) {
  const msg = error && (error.message || String(error));
  return msg && (msg.includes('was interrupted') || msg.includes('external-abort'));
}

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
  /wait [delay]        Set auto-pass delay (e.g. 5m, 1h, 1d, none)
  /workflow [name]     List or run a workflow
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
  let waitDelay = '';
  let waitTimer = null;

  /** Stop the in-memory timer without touching disk. Used for shell exit. */
  function stopWaitTimer() {
    if (waitTimer) {
      clearTimeout(waitTimer);
      waitTimer = null;
    }
  }

  /** Durably cancel the timer: null nextWakeAt and errorRetry in memory AND on disk. */
  function clearWaitTimer() {
    stopWaitTimer();
    if (activeManifest) {
      activeManifest.nextWakeAt = null;
      activeManifest.errorRetry = false;
      saveManifest(activeManifest).catch(() => {});
    }
  }

  function scheduleNextPass() {
    clearWaitTimer();
    if (!activeManifest || activeManifest.status !== 'running') return;
    const delayMs = parseWaitDelay(waitDelay);
    if (!delayMs) return;

    const wakeAt = new Date(Date.now() + delayMs).toISOString();
    activeManifest.nextWakeAt = wakeAt;
    saveManifest(activeManifest).catch(() => {});

    renderer.banner(`Next auto-pass in ${formatWaitDelay(delayMs)} (at ${wakeAt.slice(11, 19)})`);
    waitTimer = setTimeout(async () => {
      waitTimer = null;
      if (!activeManifest || activeManifest.status !== 'running') return;
      activeManifest.nextWakeAt = null;
      renderer.banner('Auto-pass starting...');
      try {
        activeManifest = await runManagerLoop(activeManifest, renderer, { singlePass: true });
        await saveManifest(activeManifest);
        scheduleNextPass();
      } catch (error) {
        if (!isAbortError(error)) {
          renderer.banner(`Run error: ${summarizeError(error)}`);
          scheduleErrorRetry();
        } else {
          renderer.banner('Run stopped by user.');
        }
      } finally {
        renderer.close();
      }
    }, delayMs);
  }

  async function runWithScheduling(manifest, renderer, loopOptions) {
    const delayMs = parseWaitDelay(waitDelay);
    if (!delayMs) {
      // No delay — use existing full loop
      return await runManagerLoop(manifest, renderer, loopOptions);
    }
    // With delay — run single pass, then schedule
    const result = await runManagerLoop(manifest, renderer, { ...loopOptions, singlePass: true });
    return result;
  }

  function scheduleErrorRetry() {
    stopWaitTimer(); // clear any existing in-memory timer
    if (!activeManifest) return;
    // Accept both 'running' and 'interrupted' (genuine errors leave status='interrupted')
    if (activeManifest.status !== 'running' && activeManifest.status !== 'interrupted') return;

    const wakeAt = new Date(Date.now() + ERROR_RETRY_DELAY_MS).toISOString();
    activeManifest.nextWakeAt = wakeAt;
    activeManifest.errorRetry = true;
    saveManifest(activeManifest).catch(() => {});

    renderer.banner(`Error backoff: retrying in 30 min (at ${wakeAt.slice(11, 19)})`);
    waitTimer = setTimeout(async () => {
      waitTimer = null;
      if (!activeManifest) return;
      // Reset status so runManagerLoop can proceed
      activeManifest.status = 'running';
      activeManifest.nextWakeAt = null;
      activeManifest.errorRetry = false;
      renderer.banner('Error-retry auto-pass starting...');
      try {
        activeManifest = await runManagerLoop(activeManifest, renderer, { singlePass: true });
        await saveManifest(activeManifest);
        scheduleNextPass();
      } catch (error) {
        if (!isAbortError(error)) {
          renderer.banner(`Run error: ${summarizeError(error)}`);
          scheduleErrorRetry();
        } else {
          renderer.banner('Run stopped by user.');
        }
      } finally {
        renderer.close();
      }
    }, ERROR_RETRY_DELAY_MS);
  }

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
          clearWaitTimer();
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
          clearWaitTimer();
          const runDir = await resolveRunDir(rest, stateRoot);
          activeManifest = await loadManifestFromDir(runDir);
          // Restore wait delay from manifest
          if (activeManifest.waitDelay) {
            waitDelay = activeManifest.waitDelay;
            renderer.banner(`Wait delay restored: ${formatWaitDelay(parseWaitDelay(waitDelay))}`);
          }
          renderer.requestStarted(activeManifest.runId);
          // Restore pending timer if nextWakeAt is set and (wait is enabled or errorRetry is set)
          // Accept 'interrupted' status for error retries (genuine errors leave status='interrupted')
          const canRestore = activeManifest.status === 'running' || (activeManifest.errorRetry && activeManifest.status === 'interrupted');
          if (activeManifest.nextWakeAt && canRestore && (parseWaitDelay(waitDelay) || activeManifest.errorRetry)) {
            const remaining = new Date(activeManifest.nextWakeAt).getTime() - Date.now();
            if (remaining > 0) {
              renderer.banner(`Pending auto-pass at ${activeManifest.nextWakeAt.slice(11, 19)}`);
              waitTimer = setTimeout(async () => {
                waitTimer = null;
                if (!activeManifest) return;
                // Reset status so runManagerLoop can proceed
                activeManifest.status = 'running';
                activeManifest.nextWakeAt = null;
                activeManifest.errorRetry = false;
                renderer.banner('Auto-pass starting...');
                try {
                  activeManifest = await runManagerLoop(activeManifest, renderer, { singlePass: true });
                  await saveManifest(activeManifest);
                  scheduleNextPass();
                } catch (error) {
                  if (!isAbortError(error)) {
                    renderer.banner(`Run error: ${summarizeError(error)}`);
                    scheduleErrorRetry();
                  } else {
                    renderer.banner('Run stopped by user.');
                  }
                } finally {
                  renderer.close();
                }
              }, remaining);
            } else {
              // Wake time already passed — run immediately
              renderer.banner('Pending auto-pass overdue, starting now...');
              activeManifest.status = 'running';
              activeManifest.nextWakeAt = null;
              activeManifest.errorRetry = false;
              try {
                activeManifest = await runManagerLoop(activeManifest, renderer, { singlePass: true });
                await saveManifest(activeManifest);
                scheduleNextPass();
              } catch (error) {
                if (!isAbortError(error)) {
                  renderer.banner(`Run error: ${summarizeError(error)}`);
                  scheduleErrorRetry();
                } else {
                  renderer.banner('Run stopped by user.');
                }
              } finally {
                renderer.close();
              }
            }
          }
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
          clearWaitTimer();
          try {
            activeManifest = await runWithScheduling(activeManifest, renderer, {});
            await saveManifest(activeManifest);
            scheduleNextPass();
          } catch (error) {
            if (!isAbortError(error)) {
              renderer.banner(`Run error: ${summarizeError(error)}`);
              scheduleErrorRetry();
            } else {
              renderer.banner('Run stopped by user.');
            }
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
          clearWaitTimer();
          activeManifest = await prepareNewRun(rest, { ...options, repoRoot: cwd, stateRoot });
          renderer.requestStarted(activeManifest.runId);
          try {
            activeManifest = await runWithScheduling(activeManifest, renderer, { userMessage: rest });
            await saveManifest(activeManifest);
            scheduleNextPass();
          } catch (error) {
            if (!isAbortError(error)) {
              renderer.banner(`Run error: ${summarizeError(error)}`);
              scheduleErrorRetry();
            } else {
              renderer.banner('Run stopped by user.');
            }
          } finally {
            renderer.close();
          }
          continue;
        }

        if (command === '/wait') {
          if (!rest) {
            const current = waitDelay || 'none';
            const opts = WAIT_OPTIONS.map(o => `  ${o.value || 'none'} — ${o.label}`).join('\n');
            renderer.banner(`Wait delay: ${current}\n\nAvailable:\n${opts}`);
            continue;
          }
          const val = rest === 'none' || rest === 'off' || rest === '0' ? '' : rest;
          const ms = parseWaitDelay(val);
          if (val && !ms) {
            renderer.banner(`Unknown delay: ${rest}. Use /wait for options.`);
            continue;
          }
          waitDelay = val;
          if (activeManifest) {
            activeManifest.waitDelay = val || null;
            // Reschedule or clear active timer (persists nextWakeAt)
            if (val && activeManifest.status === 'running') {
              scheduleNextPass();
            } else {
              clearWaitTimer();
            }
          }
          renderer.banner(`Wait delay set to: ${val ? formatWaitDelay(ms) : 'none'}`);
          continue;
        }

        if (command === '/workflow') {
          const workflows = loadWorkflows(cwd);
          if (!rest) {
            if (workflows.length === 0) {
              renderer.banner('No workflows found.\nPlace workflow directories in .cc-manager/workflows/ or ~/.cc-manager/workflows/\nEach must contain a WORKFLOW.md with YAML frontmatter (name, description).');
            } else {
              const lines = ['Available workflows:'];
              for (const wf of workflows) {
                lines.push(`  ${wf.name} — ${wf.description}`);
              }
              renderer.banner(lines.join('\n'));
            }
            continue;
          }
          const wf = workflows.find(w => w.name === rest);
          if (!wf) {
            renderer.banner(`Workflow "${rest}" not found. Use /workflow to list available workflows.`);
            continue;
          }
          let content;
          try {
            content = fs.readFileSync(wf.path, 'utf8').trim();
          } catch (err) {
            renderer.banner(`Failed to read workflow file: ${err.message}`);
            continue;
          }
          const message = `Run the workflow "${wf.name}". Read the full instructions at: ${wf.path}\n\nWorkflow summary: ${wf.description}\n\nFull workflow instructions:\n${content}`;
          clearWaitTimer();
          try {
            if (!activeManifest) {
              activeManifest = await prepareNewRun(message, { ...options, repoRoot: cwd, stateRoot });
            }
            activeManifest = await runWithScheduling(activeManifest, renderer, { userMessage: message });
            await saveManifest(activeManifest);
            scheduleNextPass();
          } catch (error) {
            if (!isAbortError(error)) {
              renderer.banner(`Run error: ${summarizeError(error)}`);
              scheduleErrorRetry();
            } else {
              renderer.banner('Run stopped by user.');
            }
          } finally {
            renderer.close();
          }
          continue;
        }

        renderer.banner(`Unknown command: ${command}`);
        continue;
      }

      clearWaitTimer();
      try {
        if (!activeManifest) {
          activeManifest = await prepareNewRun(trimmed, { ...options, repoRoot: cwd, stateRoot });
        }
        activeManifest = await runWithScheduling(activeManifest, renderer, { userMessage: trimmed });
        await saveManifest(activeManifest);
        scheduleNextPass();
      } catch (error) {
        if (!isAbortError(error)) {
          renderer.banner(`Run error: ${summarizeError(error)}`);
          scheduleErrorRetry();
        } else {
          renderer.banner('Run stopped by user.');
        }
      } finally {
        renderer.close();
      }
    }
  } finally {
    stopWaitTimer();
    rl.close();
  }
}

module.exports = {
  runInteractiveShell,
};
