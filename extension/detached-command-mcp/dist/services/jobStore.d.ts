import type { JobPaths, JobRecord, JobSummary, LaunchConfig, ServerConfig } from "../types.js";
export declare class JobStore {
    private readonly config;
    constructor(config: ServerConfig);
    initialize(): Promise<void>;
    get jobsRootDir(): string;
    getPaths(jobId: string): JobPaths;
    createJob(record: JobRecord, launchConfig: LaunchConfig): Promise<JobSummary>;
    getLaunchConfig(jobId: string): Promise<LaunchConfig>;
    getJobRecord(jobId: string): Promise<JobRecord>;
    updateJobRecord(jobId: string, updater: (current: JobRecord) => JobRecord | Promise<JobRecord>): Promise<JobSummary>;
    setJobRecord(record: JobRecord): Promise<JobSummary>;
    hasJob(jobId: string): Promise<boolean>;
    listJobIds(): Promise<string[]>;
    listJobSummaries(): Promise<JobSummary[]>;
    getJobSummary(jobId: string, skipReconcile?: boolean): Promise<JobSummary>;
    private reconcileIfNeeded;
}
