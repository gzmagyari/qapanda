const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  discoverPandaTests,
  filterPandaTests,
  loadManagedRuntimeTestState,
  upsertManagedRuntimeTestRecord,
} = require('./panda-tests');
const { defaultStateRoot } = require('./state');

const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'qapanda.js');
const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function parseDurationMs(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(/^(\d+)\s*(ms|s|m|h|d)$/i);
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === 'ms') return amount;
  if (unit === 's') return amount * 1000;
  if (unit === 'm') return amount * 60_000;
  if (unit === 'h') return amount * 3_600_000;
  if (unit === 'd') return amount * 86_400_000;
  return null;
}

function defaultAgentForPandaTest(definition, overrideAgent) {
  if (overrideAgent) return overrideAgent;
  if (definition.agent) return definition.agent;
  return definition.environment === 'computer' ? 'QA' : 'QA-Browser';
}

function executionInstructionForEnvironment(environment) {
  if (environment === 'computer') {
    return {
      execute: '7. Execute the computer test, updating each step with update_step_result.',
      workflow: '10. If you find defects, follow the normal QA bug-logging workflow.',
    };
  }
  return {
    execute: '7. Execute the browser test, updating each step with update_step_result.',
    workflow: '10. If you find defects, follow the normal QA Browser bug-logging workflow.',
  };
}

function buildManagedPandaTestPrompt(definition, runtimeTestId) {
  const instructions = executionInstructionForEnvironment(definition.environment);
  return [
    `Run the managed Panda test defined at: ${definition.relativePath}`,
    '',
    'Instructions:',
    `1. Read the source file at "${definition.relativePath}" and treat its prompt body as the authoritative test spec.`,
    `2. Use the existing cc-tests record with test_id "${runtimeTestId}". Do not create a different test unless that specific id is missing.`,
    '3. Reconcile the reusable test steps so they accurately reflect the source prompt.',
    `4. Call reset_test_steps with test_id "${runtimeTestId}" before execution.`,
    `5. Call run_test with test_id "${runtimeTestId}".`,
    instructions.execute,
    '7. Call complete_test_run when done.',
    '8. Call display_test_summary after completion.',
    `9. ${instructions.workflow.replace(/^\d+\.\s*/, '')}`,
  ].join('\n');
}

function colorize(text, style) {
  return `${style}${text}${ansi.reset}`;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) return '(unknown)';
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function normalizeSummaryText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function truncateSummaryText(text, maxLength = 160) {
  const normalized = normalizeSummaryText(text);
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function statusStyle(status) {
  if (status === 'passed') return { label: 'PASS', color: ansi.green };
  if (status === 'failed') return { label: 'FAIL', color: ansi.red };
  return { label: 'ERROR', color: ansi.yellow };
}

function formatHumanResultLine(result) {
  const status = statusStyle(result.status);
  return `${colorize(status.label, `${status.color}${ansi.bold}`)} ${result.id}  ${result.title}  ${colorize(formatDuration(result.durationMs), ansi.dim)}`;
}

function issueSummaryText(issue) {
  if (!issue || typeof issue !== 'object') return '';
  return normalizeSummaryText(
    (issue.latestProgressUpdate && issue.latestProgressUpdate.text)
    || issue.description
    || issue.detailText
    || ''
  );
}

function buildIssueSummary(issue) {
  const id = normalizeSummaryText(issue && issue.id);
  const title = normalizeSummaryText(issue && issue.title);
  const detail = issueSummaryText(issue);
  const head = title ? `${id}: ${title}` : id;
  if (!head) return '';
  if (!detail) return head;
  return `${head} — ${detail}`;
}

function buildIssueSummaries(issues) {
  if (!Array.isArray(issues)) return [];
  return issues
    .map((issue) => buildIssueSummary(issue))
    .filter(Boolean);
}

function formatHumanIssueLines(result) {
  const issues = Array.isArray(result && result.issues) ? result.issues : [];
  if (issues.length > 0) {
    return issues.map((issue) => {
      const id = normalizeSummaryText(issue && issue.id) || '(unknown issue)';
      const title = normalizeSummaryText(issue && issue.title);
      const detail = issueSummaryText(issue);
      const titleLine = title ? `Issue ${id}: ${title}` : `Issue ${id}`;
      return {
        title: colorize(titleLine, ansi.red),
        detail: detail ? colorize(truncateSummaryText(detail), ansi.red) : '',
      };
    });
  }
  if (!Array.isArray(result && result.linkedTaskIds) || result.linkedTaskIds.length === 0) return [];
  const label = result.linkedTaskIds.length === 1
    ? `Issue ${result.linkedTaskIds[0]}`
    : `Issues: ${result.linkedTaskIds.join(', ')}`;
  return [{
    title: colorize(label, ansi.red),
    detail: '',
  }];
}

function listRunIds(stateRoot) {
  const runsRoot = path.join(stateRoot, 'runs');
  try {
    return fs.readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function pickNewestRunId(stateRoot, runIds) {
  let winner = null;
  let winnerMtime = -1;
  for (const runId of runIds) {
    try {
      const manifestPath = path.join(stateRoot, 'runs', runId, 'manifest.json');
      const stats = fs.statSync(manifestPath);
      if (stats.mtimeMs >= winnerMtime) {
        winner = runId;
        winnerMtime = stats.mtimeMs;
      }
    } catch {}
  }
  return winner;
}

function findNewRunId(stateRoot, beforeRunIds) {
  const before = new Set(beforeRunIds || []);
  const after = listRunIds(stateRoot).filter((runId) => !before.has(runId));
  if (after.length === 0) return null;
  if (after.length === 1) return after[0];
  return pickNewestRunId(stateRoot, after);
}

function buildRunArtifacts(stateRoot, runId) {
  if (!runId) return {};
  const runDir = path.join(stateRoot, 'runs', runId);
  return {
    runDir,
    manifest: path.join(runDir, 'manifest.json'),
    transcript: path.join(runDir, 'transcript.jsonl'),
    chatLog: path.join(runDir, 'chat.jsonl'),
    events: path.join(runDir, 'events.jsonl'),
    progress: path.join(runDir, 'progress.md'),
  };
}

function summarizeCounts(test) {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const step of Array.isArray(test && test.steps) ? test.steps : []) {
    if (step.status === 'pass') counts.passed += 1;
    else if (step.status === 'fail') counts.failed += 1;
    else counts.skipped += 1;
  }
  return counts;
}

function collectFailures(test) {
  const failures = [];
  for (const step of Array.isArray(test && test.steps) ? test.steps : []) {
    if (step.status !== 'fail') continue;
    failures.push({
      stepId: step.id,
      step: step.description || '',
      expectedResult: step.expectedResult || '',
      actualResult: step.actualResult || '',
    });
  }
  return failures;
}

function buildTestResult(definition, runtimeBinding, execution, runId, durationMs, runtimeState) {
  const test = runtimeState.test;
  const latestRun = runtimeState.latestRun;
  const counts = summarizeCounts(test);
  const failures = collectFailures(test);

  let status = 'error';
  let message = '';
  if (!test) {
    message = 'Managed runtime test record was not found after execution.';
  } else if (!latestRun) {
    message = 'The agent did not record a test run.';
  } else if (runtimeBinding.beforeLatestRunId != null && Number(latestRun.id) === Number(runtimeBinding.beforeLatestRunId)) {
    message = 'The agent did not create a new test run.';
  } else if (execution.timedOut) {
    message = `Test timed out after ${execution.timeoutMs}ms.`;
  } else if (execution.code !== 0) {
    message = `qapanda run exited with code ${execution.code}.`;
  } else if (latestRun.status === 'passing' && counts.failed === 0) {
    status = 'passed';
  } else {
    status = 'failed';
  }

  if (status === 'passed') {
    message = 'Passed.';
  } else if (!message && failures.length > 0) {
    message = failures[0].actualResult || failures[0].step || 'One or more Panda test steps failed.';
  }

  return {
    id: definition.id,
    title: definition.title,
    sourcePath: definition.relativePath,
    tags: [...definition.tags],
    environment: definition.environment,
    agent: execution.agent,
    timeout: definition.timeout,
    status,
    message,
    runtimeTestId: runtimeBinding.runtimeTestId,
    runId,
    runStatus: latestRun ? latestRun.status : null,
    testStatus: test ? test.status : null,
    linkedTaskIds: Array.isArray(runtimeState.linkedTaskIds) ? [...runtimeState.linkedTaskIds] : [],
    notes: runtimeState.notes || null,
    issues: Array.isArray(runtimeState.issues) ? runtimeState.issues.map((issue) => ({ ...issue })) : [],
    issueSummaries: buildIssueSummaries(runtimeState.issues),
    counts,
    failures,
    durationMs,
    exitCode: execution.code,
    stdout: execution.stdout,
    stderr: execution.stderr,
    artifacts: {
      ...buildRunArtifacts(execution.stateRoot, runId),
      testsFile: runtimeState.filePath,
    },
  };
}

function createLineReader(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += String(chunk || '');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) onLine(line);
    },
    flush() {
      if (buffer) onLine(buffer);
      buffer = '';
    },
  };
}

function defaultSpawnRun(options) {
  const {
    args,
    cwd,
    timeoutMs = null,
    forwardOutput = false,
    onStdoutLine = null,
    onStderrLine = null,
  } = options;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const stdoutReader = createLineReader((line) => {
      if (typeof onStdoutLine === 'function') onStdoutLine(line);
    });
    const stderrReader = createLineReader((line) => {
      if (typeof onStderrLine === 'function') onStderrLine(line);
    });

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      stdoutReader.flush();
      stderrReader.flush();
      resolve({
        stdout,
        stderr,
        timedOut,
        timeoutMs,
        ...payload,
      });
    };

    let timeoutHandle = null;
    if (timeoutMs && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 2000).unref();
      }, timeoutMs);
      timeoutHandle.unref();
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutReader.push(text);
      if (forwardOutput) process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrReader.push(text);
      if (forwardOutput) process.stderr.write(text);
    });
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      finish({ code: 2, signal: null });
    });
    child.on('close', (code, signal) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      finish({ code: Number.isInteger(code) ? code : 1, signal });
    });
  });
}

function formatSuiteResult(results, durationMs) {
  const summary = { total: results.length, passed: 0, failed: 0, errors: 0, durationMs };
  for (const result of results) {
    if (result.status === 'passed') summary.passed += 1;
    else if (result.status === 'failed') summary.failed += 1;
    else summary.errors += 1;
  }
  return {
    suite: summary,
    tests: results,
  };
}

function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildJUnitReport(suiteResult) {
  const { suite, tests } = suiteResult;
  const cases = tests.map((result) => {
    const failureText = result.failures.map((failure) => {
      return `${failure.step}\nExpected: ${failure.expectedResult}\nActual: ${failure.actualResult}`;
    }).join('\n\n');
    let child = '';
    if (result.status === 'failed') {
      child = `<failure message="${xmlEscape(result.message)}">${xmlEscape(failureText || result.message)}</failure>`;
    } else if (result.status === 'error') {
      child = `<error message="${xmlEscape(result.message)}">${xmlEscape(result.stderr || result.stdout || result.message)}</error>`;
    }
    return `<testcase classname="qapanda.panda" name="${xmlEscape(result.id)}" time="${(result.durationMs / 1000).toFixed(3)}">${child}</testcase>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="qapanda-panda-tests" tests="${suite.total}" failures="${suite.failed}" errors="${suite.errors}" time="${(suite.durationMs / 1000).toFixed(3)}">${cases}</testsuite>\n`;
}

function writeReporterOutput(reporter, suiteResult, outputPath) {
  if (reporter === 'human' || reporter === 'ndjson') return;
  const content = reporter === 'junit'
    ? buildJUnitReport(suiteResult)
    : `${JSON.stringify(suiteResult, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content, 'utf8');
  } else {
    process.stdout.write(content);
  }
}

function createNdjsonSink(outputPath) {
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  }
  const stream = outputPath
    ? fs.createWriteStream(outputPath, { encoding: 'utf8' })
    : process.stdout;
  return {
    write(event) {
      stream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
    },
    close() {
      if (stream === process.stdout || stream === process.stderr) {
        return Promise.resolve();
      }
      return new Promise((resolve) => stream.end(resolve));
    },
  };
}

function humanLog(line = '') {
  process.stdout.write(`${line}\n`);
}

function writeHumanResult(result) {
  humanLog(formatHumanResultLine(result));
  if (result.status !== 'passed' && result.message) {
    humanLog(`  ${truncateSummaryText(result.message)}`);
  }
  const issues = formatHumanIssueLines(result);
  for (const issue of issues) {
    humanLog(`  ${issue.title}`);
    if (issue.detail) {
      humanLog(`  ${issue.detail}`);
    }
  }
}

function writeHumanSuiteSummary(suiteResult) {
  humanLog('');
  humanLog(colorize('Panda test results', `${ansi.bold}${ansi.cyan}`));
  for (const result of suiteResult.tests) {
    humanLog(`  ${formatHumanResultLine(result)}`);
    if (result.status !== 'passed' && result.message) {
      humanLog(`    ${truncateSummaryText(result.message)}`);
    }
    const issues = formatHumanIssueLines(result);
    for (const issue of issues) {
      humanLog(`    ${issue.title}`);
      if (issue.detail) {
        humanLog(`    ${issue.detail}`);
      }
    }
  }
  humanLog('');
  humanLog(colorize('Suite summary', `${ansi.bold}${ansi.cyan}`));
  humanLog(`  ${colorize(String(suiteResult.suite.passed), ansi.green)} passed`);
  humanLog(`  ${colorize(String(suiteResult.suite.failed), ansi.red)} failed`);
  humanLog(`  ${colorize(String(suiteResult.suite.errors), ansi.yellow)} errors`);
  humanLog(`  ${suiteResult.suite.total} total tests`);
  humanLog(`  total duration: ${formatDuration(suiteResult.suite.durationMs)}`);
}

function buildChildArgs(options) {
  const args = ['run'];
  if (options.workspaceName) {
    args.push('--workspace', options.workspaceName);
  } else {
    args.push('--repo', options.repoRoot);
  }
  if (options.stateRootExplicit) {
    args.push('--state-dir', options.stateRoot);
  }
  args.push('--agent', options.agent, options.prompt);
  if (options.quiet) args.splice(args.length - 1, 0, '--quiet');
  return args;
}

async function runPandaTestSuite(options = {}, deps = {}) {
  const spawnRun = deps.spawnRun || defaultSpawnRun;
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const stateRoot = path.resolve(options.stateRoot || defaultStateRoot(repoRoot));
  const discovered = discoverPandaTests(repoRoot, options.patterns || null);
  const selected = filterPandaTests(discovered, { ids: options.ids || [], tags: options.tags || [] });
  if (selected.length === 0) {
    throw new Error('No Panda tests matched the requested selection.');
  }

  const reporter = options.reporter || 'human';
  const ndjson = reporter === 'ndjson' ? createNdjsonSink(options.outputPath || null) : null;
  const startedAt = Date.now();
  const results = [];

  if (ndjson) {
    ndjson.write({
      type: 'suite.start',
      total: selected.length,
      repoRoot,
      patterns: options.patterns || null,
      ids: options.ids || [],
      tags: options.tags || [],
    });
  } else if (reporter === 'human') {
    humanLog(`Running ${selected.length} Panda test${selected.length === 1 ? '' : 's'} from ${repoRoot}`);
  }

  try {
    for (let index = 0; index < selected.length; index += 1) {
      const definition = selected[index];
      const runtimeBinding = upsertManagedRuntimeTestRecord(repoRoot, definition);
      const agent = defaultAgentForPandaTest(definition, options.agent);
      const prompt = buildManagedPandaTestPrompt(definition, runtimeBinding.runtimeTestId);
      const beforeRunIds = listRunIds(stateRoot);
      const timeoutMs = parseDurationMs(definition.timeout);

      if (ndjson) {
        ndjson.write({
          type: 'test.start',
          index: index + 1,
          total: selected.length,
          id: definition.id,
          title: definition.title,
          path: definition.relativePath,
          tags: definition.tags,
          agent,
        });
      } else if (reporter === 'human') {
        humanLog('');
        humanLog(`=== [${index + 1}/${selected.length}] ${definition.id} — ${definition.title} ===`);
      }

      const executionStartedAt = Date.now();
      const execution = await spawnRun({
        args: buildChildArgs({
          repoRoot,
          stateRoot,
          stateRootExplicit: Boolean(options.stateRootExplicit),
          workspaceName: options.workspaceName || null,
          agent,
          prompt,
          quiet: reporter !== 'human' && reporter !== 'ndjson',
        }),
        cwd: repoRoot,
        timeoutMs,
        forwardOutput: reporter === 'human',
        onStdoutLine: reporter === 'ndjson'
          ? (line) => ndjson.write({ type: 'test.stdout', id: definition.id, line })
          : null,
        onStderrLine: reporter === 'ndjson'
          ? (line) => ndjson.write({ type: 'test.stderr', id: definition.id, line })
          : null,
      });
      execution.agent = agent;
      execution.stateRoot = stateRoot;
      const durationMs = Date.now() - executionStartedAt;
      const runId = findNewRunId(stateRoot, beforeRunIds);
      const runtimeState = loadManagedRuntimeTestState(repoRoot, definition);
      const result = buildTestResult(definition, runtimeBinding, execution, runId, durationMs, runtimeState);
      results.push(result);

      if (ndjson) {
        ndjson.write({
          type: 'test.finish',
          id: definition.id,
          title: definition.title,
          status: result.status,
          runId: result.runId,
          runtimeTestId: result.runtimeTestId,
          linkedTaskIds: result.linkedTaskIds,
          notes: result.notes,
          issues: result.issues,
          issueSummaries: result.issueSummaries,
          counts: result.counts,
          durationMs: result.durationMs,
          message: result.message,
        });
      } else if (reporter === 'human') {
        humanLog('');
        writeHumanResult(result);
      }

      if (options.failFast && result.status !== 'passed') {
        break;
      }
    }
    const suiteResult = formatSuiteResult(results, Date.now() - startedAt);
    if (ndjson) {
      ndjson.write({
        type: 'suite.finish',
        summary: suiteResult.suite,
      });
    } else if (reporter === 'human') {
      writeHumanSuiteSummary(suiteResult);
    } else {
      writeReporterOutput(reporter, suiteResult, options.outputPath || null);
    }
    return suiteResult;
  } catch (error) {
    if (ndjson) {
      ndjson.write({
        type: 'suite.error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    if (ndjson) await ndjson.close();
  }
}

function listPandaTests(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const discovered = discoverPandaTests(repoRoot, options.patterns || null);
  const selected = filterPandaTests(discovered, { ids: options.ids || [], tags: options.tags || [] });
  return selected.map((definition) => {
    const runtimeState = loadManagedRuntimeTestState(repoRoot, definition);
    return {
      id: definition.id,
      title: definition.title,
      path: definition.relativePath,
      tags: [...definition.tags],
      environment: definition.environment,
      agent: defaultAgentForPandaTest(definition, options.agent || null),
      managed: true,
      runtimeTestId: runtimeState.test ? runtimeState.test.id : null,
    };
  });
}

module.exports = {
  BIN_PATH,
  buildJUnitReport,
  buildManagedPandaTestPrompt,
  defaultSpawnRun,
  listPandaTests,
  parseDurationMs,
  runPandaTestSuite,
};
