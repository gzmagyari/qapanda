import type { JobScope, JobStatusFilter, JobSummary, LogStreamName, ReadOutputMode, ServerConfig, StartCommandResult, StopJobResult } from "../types.js";
import { JobStore } from "./jobStore.js";
export declare class JobManager {
    private readonly config;
    private readonly store;
    private readonly runnerLaunchSpec;
    constructor(config: ServerConfig, store: JobStore);
    initialize(): Promise<void>;
    getCurrentInstanceId(): string;
    startCommand(input: {
        command: string;
        cwd?: string;
        env?: Record<string, string>;
        name?: string;
        shell: "auto" | "bash" | "sh" | "powershell" | "pwsh" | "cmd";
        shellExecutable?: string;
        instanceId?: string;
        startupWaitMs?: number;
    }): Promise<StartCommandResult>;
    listJobs(input: {
        scope: JobScope;
        instanceId?: string;
        statusFilter: JobStatusFilter;
        limit: number;
    }): Promise<JobSummary[]>;
    getJob(jobId: string, scope: JobScope, instanceId?: string): Promise<JobSummary>;
    stopJob(input: {
        jobId: string;
        scope: JobScope;
        instanceId?: string;
        force: boolean;
        waitMs?: number;
        requestedBy?: string;
    }): Promise<StopJobResult>;
    readOutput(input: {
        jobId: string;
        scope: JobScope;
        instanceId?: string;
        stream: LogStreamName;
        mode: ReadOutputMode;
        tailLines: number;
        lineStart?: number;
        lineEnd?: number;
        byteStart?: number;
        maxBytes: number;
    }): Promise<{
        job: JobSummary;
        stream: LogStreamName;
        mode: ReadOutputMode;
        output: string;
        totalBytes: number;
        truncated: boolean;
        nextByteOffset?: number;
        lineStart?: number;
        lineEnd?: number;
        lineCount?: number;
    }>;
    private waitForLaunchState;
    private assertVisible;
    private isVisibleForScope;
}
