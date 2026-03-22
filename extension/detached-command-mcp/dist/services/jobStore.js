import path from "node:path";
import { COMBINED_LOG_FILENAME, JOB_CONFIG_FILENAME, JOB_RECORD_FILENAME, JOBS_DIRNAME, JSON_INDENT, STDERR_LOG_FILENAME, STDOUT_LOG_FILENAME, } from "../constants.js";
import { ensureDir, listSubdirectories, pathExists, readJsonFile, safeStatSize, writeJsonAtomic } from "../utils/fs.js";
import { isProcessAlive } from "../utils/platform.js";
export class JobStore {
    config;
    constructor(config) {
        this.config = config;
    }
    async initialize() {
        await ensureDir(this.jobsRootDir);
    }
    get jobsRootDir() {
        return path.join(this.config.dataDir, JOBS_DIRNAME);
    }
    getPaths(jobId) {
        const jobDir = path.join(this.jobsRootDir, jobId);
        return {
            jobDir,
            recordPath: path.join(jobDir, JOB_RECORD_FILENAME),
            configPath: path.join(jobDir, JOB_CONFIG_FILENAME),
            stdoutLogPath: path.join(jobDir, STDOUT_LOG_FILENAME),
            stderrLogPath: path.join(jobDir, STDERR_LOG_FILENAME),
            combinedLogPath: path.join(jobDir, COMBINED_LOG_FILENAME),
        };
    }
    async createJob(record, launchConfig) {
        const paths = this.getPaths(record.jobId);
        await ensureDir(paths.jobDir);
        await Promise.all([
            writeJsonAtomic(paths.recordPath, record, JSON_INDENT),
            writeJsonAtomic(paths.configPath, launchConfig, JSON_INDENT),
        ]);
        return this.getJobSummary(record.jobId, false);
    }
    async getLaunchConfig(jobId) {
        return readJsonFile(this.getPaths(jobId).configPath);
    }
    async getJobRecord(jobId) {
        return readJsonFile(this.getPaths(jobId).recordPath);
    }
    async updateJobRecord(jobId, updater) {
        const current = await this.getJobRecord(jobId);
        const next = await updater(current);
        await writeJsonAtomic(this.getPaths(jobId).recordPath, next, JSON_INDENT);
        return this.getJobSummary(jobId, false);
    }
    async setJobRecord(record) {
        await writeJsonAtomic(this.getPaths(record.jobId).recordPath, record, JSON_INDENT);
        return this.getJobSummary(record.jobId, false);
    }
    async hasJob(jobId) {
        return pathExists(this.getPaths(jobId).recordPath);
    }
    async listJobIds() {
        return listSubdirectories(this.jobsRootDir);
    }
    async listJobSummaries() {
        const ids = await this.listJobIds();
        const results = await Promise.all(ids.map(async (jobId) => {
            try {
                return await this.getJobSummary(jobId, true);
            }
            catch {
                return undefined;
            }
        }));
        return results.filter((item) => Boolean(item));
    }
    async getJobSummary(jobId, skipReconcile = false) {
        if (!skipReconcile) {
            await this.reconcileIfNeeded(jobId);
        }
        const record = await this.getJobRecord(jobId);
        const paths = this.getPaths(jobId);
        const [stdoutBytes, stderrBytes, combinedBytes, alive] = await Promise.all([
            safeStatSize(paths.stdoutLogPath),
            safeStatSize(paths.stderrLogPath),
            safeStatSize(paths.combinedLogPath),
            isProcessAlive(record.pid),
        ]);
        return {
            ...record,
            logs: {
                stdoutBytes,
                stderrBytes,
                combinedBytes,
            },
            runtime: {
                exists: Boolean(record.pid),
                alive,
                canSignal: Boolean(record.pid) && alive,
            },
        };
    }
    async reconcileIfNeeded(jobId) {
        const record = await this.getJobRecord(jobId);
        const activeStatuses = new Set(["queued", "starting", "running", "stopping"]);
        if (!activeStatuses.has(record.status)) {
            return;
        }
        if (!record.pid) {
            return;
        }
        const alive = await isProcessAlive(record.pid);
        if (alive) {
            return;
        }
        const reconciled = {
            ...record,
            status: record.stopRequestedAt ? "stopped" : record.status === "queued" ? "unknown" : "unknown",
            endedAt: record.endedAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            error: record.error ?? (record.stopRequestedAt ? undefined : "Process is no longer running but no exit status was captured."),
        };
        await writeJsonAtomic(this.getPaths(jobId).recordPath, reconciled, JSON_INDENT);
    }
}
//# sourceMappingURL=jobStore.js.map