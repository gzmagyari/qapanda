import { z } from "zod";
export declare const scopeSchema: z.ZodDefault<z.ZodEnum<["current", "all", "explicit"]>>;
export declare const statusFilterSchema: z.ZodDefault<z.ZodEnum<["all", "active", "finished", "queued", "starting", "running", "stopping", "stopped", "exited", "failed_to_start", "unknown"]>>;
export declare const startCommandSchema: z.ZodObject<{
    command: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    name: z.ZodOptional<z.ZodString>;
    shell: z.ZodDefault<z.ZodEnum<["auto", "bash", "sh", "powershell", "pwsh", "cmd"]>>;
    shell_executable: z.ZodOptional<z.ZodString>;
    instance_id: z.ZodOptional<z.ZodString>;
    startup_wait_ms: z.ZodOptional<z.ZodNumber>;
}, "strict", z.ZodTypeAny, {
    command: string;
    shell: "auto" | "bash" | "sh" | "powershell" | "pwsh" | "cmd";
    name?: string | undefined;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    shell_executable?: string | undefined;
    instance_id?: string | undefined;
    startup_wait_ms?: number | undefined;
}, {
    command: string;
    name?: string | undefined;
    cwd?: string | undefined;
    shell?: "auto" | "bash" | "sh" | "powershell" | "pwsh" | "cmd" | undefined;
    env?: Record<string, string> | undefined;
    shell_executable?: string | undefined;
    instance_id?: string | undefined;
    startup_wait_ms?: number | undefined;
}>;
export declare const sleepSchema: z.ZodObject<{
    duration_ms: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    duration_ms: number;
}, {
    duration_ms: number;
}>;
export declare const listJobsSchema: z.ZodObject<{
    scope: z.ZodDefault<z.ZodEnum<["current", "all", "explicit"]>>;
    instance_id: z.ZodOptional<z.ZodString>;
    status_filter: z.ZodDefault<z.ZodEnum<["all", "active", "finished", "queued", "starting", "running", "stopping", "stopped", "exited", "failed_to_start", "unknown"]>>;
    limit: z.ZodDefault<z.ZodNumber>;
}, "strict", z.ZodTypeAny, {
    scope: "all" | "current" | "explicit";
    status_filter: "queued" | "starting" | "running" | "stopping" | "stopped" | "exited" | "failed_to_start" | "unknown" | "all" | "active" | "finished";
    limit: number;
    instance_id?: string | undefined;
}, {
    instance_id?: string | undefined;
    scope?: "all" | "current" | "explicit" | undefined;
    status_filter?: "queued" | "starting" | "running" | "stopping" | "stopped" | "exited" | "failed_to_start" | "unknown" | "all" | "active" | "finished" | undefined;
    limit?: number | undefined;
}>;
export declare const getJobSchema: z.ZodObject<{
    job_id: z.ZodString;
    scope: z.ZodDefault<z.ZodEnum<["current", "all", "explicit"]>>;
    instance_id: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    scope: "all" | "current" | "explicit";
    job_id: string;
    instance_id?: string | undefined;
}, {
    job_id: string;
    instance_id?: string | undefined;
    scope?: "all" | "current" | "explicit" | undefined;
}>;
export declare const stopJobSchema: z.ZodObject<{
    job_id: z.ZodString;
    scope: z.ZodDefault<z.ZodEnum<["current", "all", "explicit"]>>;
    instance_id: z.ZodOptional<z.ZodString>;
    force: z.ZodDefault<z.ZodBoolean>;
    wait_ms: z.ZodOptional<z.ZodNumber>;
}, "strict", z.ZodTypeAny, {
    force: boolean;
    scope: "all" | "current" | "explicit";
    job_id: string;
    instance_id?: string | undefined;
    wait_ms?: number | undefined;
}, {
    job_id: string;
    force?: boolean | undefined;
    instance_id?: string | undefined;
    scope?: "all" | "current" | "explicit" | undefined;
    wait_ms?: number | undefined;
}>;
export declare const readOutputSchema: z.ZodObject<{
    job_id: z.ZodString;
    scope: z.ZodDefault<z.ZodEnum<["current", "all", "explicit"]>>;
    instance_id: z.ZodOptional<z.ZodString>;
    stream: z.ZodDefault<z.ZodEnum<["combined", "stdout", "stderr"]>>;
    mode: z.ZodDefault<z.ZodEnum<["tail", "range", "all", "offset"]>>;
    tail_lines: z.ZodDefault<z.ZodNumber>;
    line_start: z.ZodOptional<z.ZodNumber>;
    line_end: z.ZodOptional<z.ZodNumber>;
    byte_start: z.ZodOptional<z.ZodNumber>;
    max_bytes: z.ZodOptional<z.ZodNumber>;
}, "strict", z.ZodTypeAny, {
    stream: "combined" | "stdout" | "stderr";
    mode: "tail" | "range" | "all" | "offset";
    scope: "all" | "current" | "explicit";
    job_id: string;
    tail_lines: number;
    instance_id?: string | undefined;
    line_start?: number | undefined;
    line_end?: number | undefined;
    byte_start?: number | undefined;
    max_bytes?: number | undefined;
}, {
    job_id: string;
    stream?: "combined" | "stdout" | "stderr" | undefined;
    mode?: "tail" | "range" | "all" | "offset" | undefined;
    instance_id?: string | undefined;
    scope?: "all" | "current" | "explicit" | undefined;
    tail_lines?: number | undefined;
    line_start?: number | undefined;
    line_end?: number | undefined;
    byte_start?: number | undefined;
    max_bytes?: number | undefined;
}>;
