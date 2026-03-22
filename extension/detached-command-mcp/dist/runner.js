#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { JobStore } from "./services/jobStore.js";
import { buildShellLaunchSpec, mergeEnv } from "./utils/platform.js";
class PrefixedCombinedWriter {
    streamName;
    destination;
    buffer = "";
    constructor(streamName, destination) {
        this.streamName = streamName;
        this.destination = destination;
    }
    write(chunk) {
        this.buffer += chunk.toString("utf8");
        this.flushCompleteLines();
    }
    flush() {
        if (this.buffer.length === 0) {
            return;
        }
        this.destination.write(this.formatLine(this.buffer));
        this.buffer = "";
    }
    flushCompleteLines() {
        while (true) {
            const newlineIndex = this.buffer.indexOf("\n");
            if (newlineIndex === -1) {
                break;
            }
            const line = this.buffer.slice(0, newlineIndex);
            this.buffer = this.buffer.slice(newlineIndex + 1);
            this.destination.write(this.formatLine(line));
        }
    }
    formatLine(line) {
        return `[${new Date().toISOString()}][${this.streamName}] ${line}\n`;
    }
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const store = new JobStore(buildRunnerConfig(args.dataDir));
    await store.initialize();
    const launchConfig = await store.getLaunchConfig(args.jobId);
    const paths = store.getPaths(args.jobId);
    const stdoutLog = createWriteStream(paths.stdoutLogPath, { flags: "a" });
    const stderrLog = createWriteStream(paths.stderrLogPath, { flags: "a" });
    const combinedLog = createWriteStream(paths.combinedLogPath, { flags: "a" });
    const combinedStdout = new PrefixedCombinedWriter("stdout", combinedLog);
    const combinedStderr = new PrefixedCombinedWriter("stderr", combinedLog);
    const now = new Date().toISOString();
    await store.updateJobRecord(args.jobId, (current) => ({
        ...current,
        status: "starting",
        runnerPid: process.pid,
        updatedAt: now,
    }));
    let spawned;
    try {
        spawned = await spawnWithFallback(launchConfig);
    }
    catch (error) {
        await finalizeFailedStart(store, args.jobId, error instanceof Error ? error.message : String(error));
        stdoutLog.end();
        stderrLog.end();
        combinedLog.end();
        process.exitCode = 1;
        return;
    }
    const child = spawned.child;
    attachOutput(child, stdoutLog, stderrLog, combinedStdout, combinedStderr);
    const startTime = new Date().toISOString();
    await store.updateJobRecord(args.jobId, (current) => ({
        ...current,
        status: "running",
        pid: child.pid ?? current.pid,
        shell: spawned.actualShell,
        shellExecutable: spawned.executable,
        startedAt: startTime,
        updatedAt: startTime,
        error: undefined,
        exitCode: null,
        signal: null,
    }));
    child.once("error", async (error) => {
        await finalizeFailedStart(store, args.jobId, error.message);
        combinedStdout.flush();
        combinedStderr.flush();
        stdoutLog.end();
        stderrLog.end();
        combinedLog.end();
        process.exitCode = 1;
    });
    child.once("close", async (code, signal) => {
        combinedStdout.flush();
        combinedStderr.flush();
        const existing = await store.getJobRecord(args.jobId);
        const endedAt = new Date().toISOString();
        const nextStatus = existing.stopRequestedAt ? "stopped" : "exited";
        await store.setJobRecord({
            ...existing,
            status: nextStatus,
            exitCode: code,
            signal,
            endedAt,
            updatedAt: endedAt,
        });
        stdoutLog.end();
        stderrLog.end();
        combinedLog.end();
    });
}
function parseArgs(argv) {
    let jobId;
    let dataDir;
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === "--job-id") {
            jobId = argv[index + 1];
            index += 1;
            continue;
        }
        if (value === "--data-dir") {
            dataDir = argv[index + 1];
            index += 1;
            continue;
        }
    }
    if (!jobId || !dataDir) {
        throw new Error("runner requires --job-id and --data-dir");
    }
    return {
        jobId,
        dataDir: path.resolve(dataDir),
    };
}
function buildRunnerConfig(dataDir) {
    return {
        dataDir,
        currentInstanceId: "runner",
        currentInstanceProvidedByEnv: false,
        startupWaitMs: 0,
        defaultTailLines: 0,
        defaultReadMaxBytes: 0,
        maxReadBytes: 0,
        maxListResults: 0,
        defaultStopWaitMs: 0,
        maxCommandLength: 0,
    };
}
async function spawnWithFallback(config) {
    try {
        return await spawnChild(config.command, config.shell, config.shellExecutable, config.cwd, config.env);
    }
    catch (error) {
        const maybeErr = error;
        if (maybeErr.code !== "ENOENT" || config.shell !== "auto") {
            throw error;
        }
        const fallbackShell = process.platform === "win32" ? "cmd" : "sh";
        return spawnChild(config.command, fallbackShell, undefined, config.cwd, config.env);
    }
}
async function spawnChild(command, shell, shellExecutable, cwd, env) {
    const spec = buildShellLaunchSpec(command, shell, shellExecutable);
    const child = spawn(spec.executable, spec.args, {
        cwd,
        env: mergeEnv(env),
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
    });
    return {
        child,
        actualShell: spec.shellKind,
        executable: spec.executable,
    };
}
function attachOutput(child, stdoutLog, stderrLog, combinedStdout, combinedStderr) {
    child.stdout.on("data", (chunk) => {
        stdoutLog.write(chunk);
        combinedStdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
        stderrLog.write(chunk);
        combinedStderr.write(chunk);
    });
}
async function finalizeFailedStart(store, jobId, message) {
    const now = new Date().toISOString();
    await store.updateJobRecord(jobId, (current) => ({
        ...current,
        status: "failed_to_start",
        error: message,
        updatedAt: now,
        endedAt: now,
    }));
}
process.on("uncaughtException", async (error) => {
    try {
        const args = parseArgs(process.argv.slice(2));
        const store = new JobStore(buildRunnerConfig(args.dataDir));
        await finalizeFailedStart(store, args.jobId, `Runner crashed: ${error.message}`);
    }
    catch {
        // Ignore secondary failures during crash handling.
    }
    process.exit(1);
});
process.on("unhandledRejection", async (reason) => {
    try {
        const args = parseArgs(process.argv.slice(2));
        const store = new JobStore(buildRunnerConfig(args.dataDir));
        await finalizeFailedStart(store, args.jobId, `Runner rejected: ${String(reason)}`);
    }
    catch {
        // Ignore secondary failures during crash handling.
    }
    process.exit(1);
});
await main();
//# sourceMappingURL=runner.js.map