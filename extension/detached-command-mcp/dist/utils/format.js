export function formatJobSummary(job) {
    const parts = [];
    parts.push(`job_id: ${job.jobId}`);
    parts.push(`instance_id: ${job.instanceId}`);
    parts.push(`status: ${job.status}`);
    if (job.name) {
        parts.push(`name: ${job.name}`);
    }
    if (job.pid) {
        parts.push(`pid: ${job.pid}`);
    }
    if (job.runnerPid) {
        parts.push(`runner_pid: ${job.runnerPid}`);
    }
    parts.push(`cwd: ${job.cwd}`);
    parts.push(`shell: ${job.shell}${job.shellExecutable ? ` (${job.shellExecutable})` : ""}`);
    parts.push(`created_at: ${job.createdAt}`);
    if (job.startedAt) {
        parts.push(`started_at: ${job.startedAt}`);
    }
    if (job.endedAt) {
        parts.push(`ended_at: ${job.endedAt}`);
    }
    if (job.exitCode !== undefined) {
        parts.push(`exit_code: ${job.exitCode}`);
    }
    if (job.signal !== undefined) {
        parts.push(`signal: ${job.signal}`);
    }
    parts.push(`runtime_alive: ${job.runtime.alive}`);
    parts.push(`combined_log_bytes: ${job.logs.combinedBytes}`);
    parts.push(`stdout_log_bytes: ${job.logs.stdoutBytes}`);
    parts.push(`stderr_log_bytes: ${job.logs.stderrBytes}`);
    if (job.error) {
        parts.push(`error: ${job.error}`);
    }
    parts.push(`command: ${job.command}`);
    return parts.join("\n");
}
export function formatJobList(jobs) {
    if (jobs.length === 0) {
        return "No jobs matched the requested scope and filters.";
    }
    return jobs
        .map((job, index) => {
        const headline = `${index + 1}. ${job.jobId} | ${job.status} | instance=${job.instanceId}${job.pid ? ` | pid=${job.pid}` : ""}`;
        const nameLine = job.name ? `   name: ${job.name}` : undefined;
        const cwdLine = `   cwd: ${job.cwd}`;
        const cmdLine = `   command: ${job.command}`;
        return [headline, nameLine, cwdLine, cmdLine].filter(Boolean).join("\n");
    })
        .join("\n\n");
}
export function formatOutputBlock(title, output) {
    if (!output) {
        return `${title}\n\n<no output>`;
    }
    return `${title}\n\n${output}`;
}
//# sourceMappingURL=format.js.map