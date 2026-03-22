export type JobStatus = "queued" | "starting" | "running" | "stopping" | "stopped" | "exited" | "failed_to_start" | "unknown";
export type ShellKind = "auto" | "bash" | "sh" | "powershell" | "pwsh" | "cmd";
export type LogStreamName = "combined" | "stdout" | "stderr";
export type ReadOutputMode = "tail" | "range" | "all" | "offset";
export type JobScope = "current" | "all" | "explicit";
export type JobStatusFilter = "all" | "active" | "finished" | "queued" | "starting" | "running" | "stopping" | "stopped" | "exited" | "failed_to_start" | "unknown";
export interface JobPaths {
    jobDir: string;
    recordPath: string;
    configPath: string;
    stdoutLogPath: string;
    stderrLogPath: string;
    combinedLogPath: string;
}
export interface LaunchConfig {
    jobId: string;
    instanceId: string;
    name?: string;
    command: string;
    cwd: string;
    shell: ShellKind;
    shellExecutable?: string;
    env?: Record<string, string>;
    createdAt: string;
}
export interface JobRecord {
    jobId: string;
    instanceId: string;
    name?: string;
    command: string;
    cwd: string;
    shell: ShellKind;
    shellExecutable?: string;
    status: JobStatus;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    endedAt?: string;
    runnerPid?: number;
    pid?: number;
    exitCode?: number | null;
    signal?: string | null;
    error?: string;
    stopRequestedAt?: string;
    stopRequestedBy?: string;
    forceStopRequested?: boolean;
}
export interface JobRuntimeDetails {
    exists: boolean;
    alive: boolean;
    canSignal: boolean;
}
export interface JobSummary extends JobRecord {
    logs: {
        stdoutBytes: number;
        stderrBytes: number;
        combinedBytes: number;
    };
    runtime: JobRuntimeDetails;
}
export interface ServerConfig {
    dataDir: string;
    currentInstanceId: string;
    currentInstanceProvidedByEnv: boolean;
    startupWaitMs: number;
    defaultTailLines: number;
    defaultReadMaxBytes: number;
    maxReadBytes: number;
    maxListResults: number;
    defaultStopWaitMs: number;
    maxCommandLength: number;
}
export interface TailReadResult {
    text: string;
    lineCount: number;
    truncated: boolean;
}
export interface RangeReadResult {
    text: string;
    startLine: number;
    endLine: number;
    lineCount: number;
    truncated: boolean;
}
export interface ByteChunkReadResult {
    text: string;
    byteStart: number;
    byteEnd: number;
    nextByteOffset: number;
    totalBytes: number;
    truncated: boolean;
}
export interface StartCommandResult {
    job: JobSummary;
    launchState: JobStatus;
}
export interface StopJobResult {
    job: JobSummary;
    requestedSignal: string;
    force: boolean;
    stopIssued: boolean;
    stillRunningAfterWait: boolean;
}
