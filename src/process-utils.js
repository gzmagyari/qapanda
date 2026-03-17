const { spawn, execSync, exec } = require('node:child_process');
const readline = require('node:readline');

/**
 * On Windows, npm-installed binaries are .cmd shims that need a shell.
 * We use execFile-style quoting by letting Node handle it via
 * spawn with shell:true + windowsVerbatimArguments:false (default).
 * To avoid argument mangling we escape each arg for cmd.exe.
 */
function winEscapeArg(arg) {
  // Wrap in double quotes, escape internal double quotes and special cmd chars
  // Replace " with \"  and escape shell metacharacters inside quotes
  const escaped = arg.replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Kill a process and its entire process tree.
 * On Windows, child.kill() doesn't kill grandchildren, so we use taskkill /F /T.
 * On Unix, we send SIGTERM then SIGKILL after a short delay.
 */
function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    // Run taskkill asynchronously so it never blocks the caller
    exec(`taskkill /F /T /PID ${pid}`, { timeout: 10000 }, () => {});
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }, 250).unref();
  }
}

function spawnArgs(command, args, options) {
  if (process.platform === 'win32') {
    // .js/.mjs files must be explicitly run with node on Windows because the
    // default .js file association (WScript.exe) cannot execute Node scripts.
    if (command.endsWith('.js') || command.endsWith('.mjs')) {
      const escapedArgs = [command, ...args].map(winEscapeArg);
      const cmdLine = `"${process.execPath}" ${escapedArgs.join(' ')}`;
      return spawn(cmdLine, [], { ...options, shell: true });
    }
    // Build the full command line with proper escaping for cmd.exe
    const escapedArgs = args.map(winEscapeArg);
    const cmdLine = `"${command}" ${escapedArgs.join(' ')}`;
    return spawn(cmdLine, [], { ...options, shell: true });
  }
  return spawn(command, args, options);
}

function execForText(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnArgs(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

function spawnStreamingProcess({
  command,
  args = [],
  cwd,
  env,
  stdinText,
  abortSignal,
  onStdoutLine,
  onStderrLine,
}) {
  return new Promise((resolve, reject) => {
    const child = spawnArgs(command, args, {
      cwd,
      env: env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let aborted = false;
    let resolved = false;
    const stdoutLines = [];
    const stderrLines = [];

    const stdoutReader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const stderrReader = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });

    stdoutReader.on('line', (line) => {
      stdoutLines.push(line);
      if (onStdoutLine) {
        onStdoutLine(line);
      }
    });

    stderrReader.on('line', (line) => {
      stderrLines.push(line);
      if (onStderrLine) {
        onStderrLine(line);
      }
    });

    child.on('error', reject);

    const doResolve = (result) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    const onAbort = () => {
      aborted = true;
      // Destroy stdio streams first — unblocks readline immediately without waiting for process death
      try { child.stdout.destroy(); } catch {}
      try { child.stderr.destroy(); } catch {}
      try { child.stdin.destroy(); } catch {}
      killProcessTree(child.pid);
      // Resolve immediately — don't wait for streams to drain after kill
      stdoutReader.close();
      stderrReader.close();
      doResolve({ code: null, signal: 'SIGTERM', aborted: true, stdoutLines, stderrLines });
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }

    if (stdinText != null) {
      child.stdin.write(stdinText, () => child.stdin.end());
    } else {
      child.stdin.end();
    }

    child.on('close', (code, signal) => {
      stdoutReader.close();
      stderrReader.close();
      doResolve({ code, signal, aborted, stdoutLines, stderrLines });
    });

    // Resolve as soon as stdout closes — we have all the output we need.
    // Don't wait for child.on('close') which requires stderr to drain too;
    // on Windows with shell:true, cmd.exe can hold stderr open after the
    // process exits, causing a hang of up to ~60s.
    // If child.exitCode is still null (shell wrapper not yet dead), fall back
    // to 0 — stdout closed cleanly so the process completed successfully.
    stdoutReader.on('close', () => {
      doResolve({ code: child.exitCode ?? 0, signal: child.signalCode ?? null, aborted, stdoutLines, stderrLines });
    });
  });
}

module.exports = {
  execForText,
  killProcessTree,
  spawnStreamingProcess,
};
