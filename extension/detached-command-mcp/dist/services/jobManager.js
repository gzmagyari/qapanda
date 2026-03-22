import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { UserError } from "../utils/errors.js";
import { sleep } from "../utils/fs.js";
import { killProcessTree } from "../utils/platform.js";
import { readByteChunk, readFull, readLineRange, readTailLines } from "./logReader.js";
const ACTIVE_STATUSES = new Set(["queued", "starting", "running", "stopping"]);
const FINISHED_STATUSES = new Set(["stopped", "exited", "failed_to_start", "unknown"]);
export class JobManager {
    config;
    store;
    runnerLaunchSpec;
    constructor(config, store) {
        this.config = config;
        this.store = store;
        this.runnerLaunchSpec = resolveRunnerLaunchSpec();
    }
    async initialize() {
        await this.store.initialize();
    }
    getCurrentInstanceId() {
        return this.config.currentInstanceId;
    }
    async startCommand(input) {
        const trimmedCommand = input.command.trim();
        if (trimmedCommand.length === 0) {
            throw new UserError("command must not be empty");
        }
        if (trimmedCommand.length > this.config.maxCommandLength) {
            throw new UserError(`command exceeds maximum length of ${this.config.maxCommandLength} characters`);
        }
        const cwd = path.resolve(input.cwd ?? process.cwd());
        const cwdStats = await fs.stat(cwd).catch(() => undefined);
        if (!cwdStats?.isDirectory()) {
            throw new UserError(`cwd does not exist or is not a directory: ${cwd}`);
        }
        const jobId = randomUUID();
        const instanceId = input.instanceId?.trim() || this.config.currentInstanceId;
        const now = new Date().toISOString();
        const record = {
            jobId,
            instanceId,
            name: input.name?.trim() || undefined,
            command: trimmedCommand,
            cwd,
            shell: input.shell,
            shellExecutable: input.shellExecutable,
            status: "queued",
            createdAt: now,
            updatedAt: now,
            exitCode: null,
            signal: null,
            logs: {
                stdoutBytes: 0,
                stderrBytes: 0,
                combinedBytes: 0,
            },
            runtime: {
                exists: false,
                alive: false,
                canSignal: false,
            },
        };
        const launchConfig = {
            jobId,
            instanceId,
            name: input.name?.trim() || undefined,
            command: trimmedCommand,
            cwd,
            shell: input.shell,
            shellExecutable: input.shellExecutable,
            env: input.env,
            createdAt: now,
        };
        await this.store.createJob(stripSummary(record), launchConfig);
        let runnerPid;
        try {
            const runner = spawn(this.runnerLaunchSpec.executable, [...this.runnerLaunchSpec.args, "--job-id", jobId, "--data-dir", this.config.dataDir], {
                detached: true,
                stdio: "ignore",
                windowsHide: true,
                env: process.env,
            });
            runnerPid = runner.pid;
            runner.unref();
        }
        catch (error) {
            await this.store.updateJobRecord(jobId, (current) => ({
                ...current,
                status: "failed_to_start",
                error: `Failed to launch detached runner: ${error.message}`,
                updatedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
            }));
            throw error;
        }
        await this.store.updateJobRecord(jobId, (current) => ({
            ...current,
            runnerPid: current.runnerPid ?? runnerPid,
            updatedAt: new Date().toISOString(),
        }));
        const startupWaitMs = input.startupWaitMs ?? this.config.startupWaitMs;
        const job = await this.waitForLaunchState(jobId, startupWaitMs);
        return {
            job,
            launchState: job.status === "failed_to_start" ? "failed_to_start" : job.status === "running" ? "running" : job.status,
        };
    }
    async listJobs(input) {
        const effectiveLimit = Math.max(1, Math.min(input.limit, this.config.maxListResults));
        const jobs = await this.store.listJobSummaries();
        return jobs
            .filter((job) => this.isVisibleForScope(job, input.scope, input.instanceId))
            .filter((job) => matchesStatusFilter(job, input.statusFilter))
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
            .slice(0, effectiveLimit);
    }
    async getJob(jobId, scope, instanceId) {
        const job = await this.store.getJobSummary(jobId);
        this.assertVisible(job, scope, instanceId);
        return job;
    }
    async stopJob(input) {
        const job = await this.getJob(input.jobId, input.scope, input.instanceId);
        const waitMs = input.waitMs ?? this.config.defaultStopWaitMs;
        if (!job.pid || !job.runtime.alive) {
            const refreshed = await this.store.getJobSummary(job.jobId);
            return {
                job: refreshed,
                requestedSignal: "none",
                force: input.force,
                stopIssued: false,
                stillRunningAfterWait: refreshed.runtime.alive,
            };
        }
        await this.store.updateJobRecord(job.jobId, (current) => ({
            ...current,
            status: current.status === "running" || current.status === "starting" ? "stopping" : current.status,
            stopRequestedAt: new Date().toISOString(),
            stopRequestedBy: input.requestedBy,
            forceStopRequested: input.force,
            updatedAt: new Date().toISOString(),
        }));
        const killResult = await killProcessTree(job.pid, input.force, waitMs);
        const refreshed = await this.store.getJobSummary(job.jobId);
        return {
            job: refreshed,
            requestedSignal: killResult.requestedSignal,
            force: input.force,
            stopIssued: true,
            stillRunningAfterWait: killResult.stillRunning,
        };
    }
    async readOutput(input) {
        const job = await this.getJob(input.jobId, input.scope, input.instanceId);
        const paths = this.store.getPaths(job.jobId);
        const logPath = getLogPath(paths, input.stream);
        const stats = await fs.stat(logPath).catch(() => undefined);
        if (!stats) {
            return {
                job,
                stream: input.stream,
                mode: input.mode,
                output: "",
                totalBytes: 0,
                truncated: false,
                nextByteOffset: 0,
            };
        }
        switch (input.mode) {
            case "tail": {
                const result = await readTailLines(logPath, input.tailLines, input.maxBytes);
                return {
                    job,
                    stream: input.stream,
                    mode: input.mode,
                    output: result.text,
                    totalBytes: stats.size,
                    truncated: result.truncated,
                    lineCount: result.lineCount,
                };
            }
            case "range": {
                if (input.lineStart === undefined) {
                    throw new UserError("line_start is required when mode is 'range'");
                }
                const result = await readLineRange(logPath, input.lineStart, input.lineEnd, input.maxBytes);
                return {
                    job,
                    stream: input.stream,
                    mode: input.mode,
                    output: result.text,
                    totalBytes: stats.size,
                    truncated: result.truncated,
                    lineStart: result.startLine,
                    lineEnd: result.endLine,
                    lineCount: result.lineCount,
                };
            }
            case "all": {
                const result = await readFull(logPath, input.maxBytes);
                return {
                    job,
                    stream: input.stream,
                    mode: input.mode,
                    output: result.text,
                    totalBytes: result.totalBytes,
                    truncated: result.truncated,
                    nextByteOffset: result.nextByteOffset,
                };
            }
            case "offset": {
                const result = await readByteChunk(logPath, input.byteStart ?? 0, input.maxBytes);
                return {
                    job,
                    stream: input.stream,
                    mode: input.mode,
                    output: result.text,
                    totalBytes: result.totalBytes,
                    truncated: result.truncated,
                    nextByteOffset: result.nextByteOffset,
                };
            }
            default: {
                const exhaustiveCheck = input.mode;
                throw new UserError(`Unsupported output read mode: ${exhaustiveCheck}`);
            }
        }
    }
    async waitForLaunchState(jobId, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        let latest = await this.store.getJobSummary(jobId);
        while (Date.now() < deadline) {
            latest = await this.store.getJobSummary(jobId);
            if (latest.status === "running" || latest.status === "failed_to_start" || latest.status === "exited") {
                return latest;
            }
            await sleep(100);
        }
        return latest;
    }
    assertVisible(job, scope, instanceId) {
        if (!this.isVisibleForScope(job, scope, instanceId)) {
            throw new UserError(`Job ${job.jobId} is not visible in the selected scope.`);
        }
    }
    isVisibleForScope(job, scope, instanceId) {
        switch (scope) {
            case "all":
                return true;
            case "current":
                return job.instanceId === this.config.currentInstanceId;
            case "explicit":
                return Boolean(instanceId) && job.instanceId === instanceId;
            default: {
                const exhaustiveCheck = scope;
                throw new UserError(`Unsupported scope: ${exhaustiveCheck}`);
            }
        }
    }
}
function resolveRunnerLaunchSpec() {
    const currentFilePath = fileURLToPath(import.meta.url);
    const currentDir = path.dirname(currentFilePath);
    if (currentFilePath.endsWith(path.join("src", "services", "jobManager.ts"))) {
        return {
            executable: process.execPath,
            args: ["--loader", "tsx", path.join(currentDir, "..", "runner.ts")],
        };
    }
    return {
        executable: process.execPath,
        args: [path.join(currentDir, "..", "runner.js")],
    };
}
function getLogPath(paths, stream) {
    switch (stream) {
        case "stdout":
            return paths.stdoutLogPath;
        case "stderr":
            return paths.stderrLogPath;
        case "combined":
            return paths.combinedLogPath;
        default: {
            const exhaustiveCheck = stream;
            throw new UserError(`Unsupported log stream: ${exhaustiveCheck}`);
        }
    }
}
function matchesStatusFilter(job, filter) {
    if (filter === "all") {
        return true;
    }
    if (filter === "active") {
        return ACTIVE_STATUSES.has(job.status);
    }
    if (filter === "finished") {
        return FINISHED_STATUSES.has(job.status);
    }
    return job.status === filter;
}
function stripSummary(job) {
    const { logs: _logs, runtime: _runtime, ...record } = job;
    return record;
}
//# sourceMappingURL=jobManager.js.map