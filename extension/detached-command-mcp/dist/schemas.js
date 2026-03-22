import { z } from "zod";
export const scopeSchema = z.enum(["current", "all", "explicit"]).default("current").describe("How to scope job visibility. 'current' only shows jobs created by this MCP server instance. 'all' shows every job in the shared data directory. 'explicit' only shows jobs for the provided instance_id.");
export const statusFilterSchema = z
    .enum(["all", "active", "finished", "queued", "starting", "running", "stopping", "stopped", "exited", "failed_to_start", "unknown"])
    .default("active")
    .describe("Filter jobs by status. 'active' means queued, starting, running, or stopping.");
export const startCommandSchema = z
    .object({
    command: z
        .string()
        .min(1)
        .describe("Shell command text to execute in a fully detached process. This is executed inside the selected shell."),
    cwd: z.string().optional().describe("Working directory for the command. Defaults to the MCP server process working directory."),
    env: z.record(z.string()).optional().describe("Extra environment variables to add or override for the detached command."),
    name: z.string().optional().describe("Optional human-friendly label for the job."),
    shell: z
        .enum(["auto", "bash", "sh", "powershell", "pwsh", "cmd"])
        .default("auto")
        .describe("Shell to use. 'auto' uses bash on Linux and Windows PowerShell on Windows."),
    shell_executable: z
        .string()
        .optional()
        .describe("Optional absolute or PATH-resolved shell executable override, such as a custom bash.exe path on Windows."),
    instance_id: z
        .string()
        .optional()
        .describe("Optional logical instance ID to associate with the job. If omitted, the current MCP server instance ID is used."),
    startup_wait_ms: z
        .number()
        .int()
        .positive()
        .max(30000)
        .optional()
        .describe("How long to wait for the detached runner to report a PID before returning."),
})
    .strict();
export const listJobsSchema = z
    .object({
    scope: scopeSchema,
    instance_id: z
        .string()
        .optional()
        .describe("Required when scope is 'explicit'. Ignored for 'current' and 'all'."),
    status_filter: statusFilterSchema,
    limit: z.number().int().positive().max(1000).default(100).describe("Maximum number of jobs to return."),
})
    .strict();
export const getJobSchema = z
    .object({
    job_id: z.string().min(1).describe("Job ID returned by start_command or list_jobs."),
    scope: scopeSchema,
    instance_id: z.string().optional().describe("Required when scope is 'explicit'."),
})
    .strict();
export const stopJobSchema = z
    .object({
    job_id: z.string().min(1).describe("Job ID to stop."),
    scope: scopeSchema,
    instance_id: z.string().optional().describe("Required when scope is 'explicit'."),
    force: z
        .boolean()
        .default(false)
        .describe("If true, forcefully kills the job tree immediately. On Windows this uses taskkill /F /T."),
    wait_ms: z
        .number()
        .int()
        .positive()
        .max(60000)
        .optional()
        .describe("How long to wait for graceful shutdown before escalating."),
})
    .strict();
export const readOutputSchema = z
    .object({
    job_id: z.string().min(1).describe("Job ID whose logs should be read."),
    scope: scopeSchema,
    instance_id: z.string().optional().describe("Required when scope is 'explicit'."),
    stream: z
        .enum(["combined", "stdout", "stderr"])
        .default("combined")
        .describe("Which log stream to read. 'combined' includes both stdout and stderr with timestamps and stream markers."),
    mode: z
        .enum(["tail", "range", "all", "offset"])
        .default("tail")
        .describe("Read mode. 'tail' returns the last tail_lines lines. 'range' returns a 1-indexed inclusive line range. 'all' reads from byte 0 up to max_bytes. 'offset' reads a byte chunk from byte_start."),
    tail_lines: z.number().int().positive().max(10000).default(120).describe("Number of trailing lines to return when mode is 'tail'."),
    line_start: z.number().int().positive().optional().describe("1-indexed first line to include when mode is 'range'."),
    line_end: z.number().int().positive().optional().describe("1-indexed last line to include when mode is 'range'. Inclusive."),
    byte_start: z.number().int().min(0).optional().describe("Starting byte offset when mode is 'offset'."),
    max_bytes: z.number().int().positive().max(5 * 1024 * 1024).optional().describe("Maximum number of bytes to return."),
})
    .strict();
//# sourceMappingURL=schemas.js.map