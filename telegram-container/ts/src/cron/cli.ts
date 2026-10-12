import {
  KIND_AGENT,
  addAgentJob,
  deleteAgentJob,
  getJob,
  listCronJobs,
  pruneRunSlots,
  setAgentJobEnabled,
  updateAgentJob,
} from "./store.js";
import { runCronOnce } from "./run_once.js";

const CRON_USAGE =
  "usage: melvbot cron list | get <id> | add --name --schedule --prompt | update <id> [--name] [--schedule] [--prompt] | enable <id> | disable <id> | delete <id> | run-once <id> [--force] | prune-slots\n";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): number {
  process.stderr.write(CRON_USAGE);
  return 2;
}

/** melvbot cron list never prints prompt bodies. */
function jobSummary(job: ReturnType<typeof getJob>): unknown {
  if (!job) {
    return job;
  }
  return {
    id: job.id,
    name: job.name,
    kind: job.kind,
    schedule: job.schedule,
    enabled: job.enabled,
    editable: job.kind === KIND_AGENT,
  };
}

export async function runCronCli(args: string[]): Promise<number> {
  try {
    if (args[0] === "list") {
      writeJson(listCronJobs().map((job) => jobSummary(job)));
      return 0;
    }
    if (args[0] === "get") {
      const id = args[1];
      if (!id) {
        return usage();
      }
      const job = getJob(id);
      if (!job) {
        throw new Error(`cron job not found: ${id}`);
      }
      if (job.kind !== KIND_AGENT) {
        throw new Error(`${job.name} (${id}) is a ${job.kind} job and can't be read this way`);
      }
      writeJson(job);
      return 0;
    }
    if (args[0] === "add") {
      const rest = args.slice(1);
      const name = flag(rest, "--name");
      const schedule = flag(rest, "--schedule");
      const prompt = flag(rest, "--prompt");
      if (!name || !schedule || !prompt) {
        return usage();
      }
      writeJson(jobSummary(addAgentJob({ name, schedule, prompt })));
      return 0;
    }
    if (args[0] === "update") {
      const id = args[1];
      const rest = args.slice(2);
      if (!id) {
        return usage();
      }
      writeJson(
        jobSummary(
          updateAgentJob(id, {
            name: flag(rest, "--name"),
            schedule: flag(rest, "--schedule"),
            prompt: flag(rest, "--prompt"),
          }),
        ),
      );
      return 0;
    }
    if (args[0] === "enable" || args[0] === "disable") {
      const id = args[1];
      if (!id) {
        return usage();
      }
      writeJson(jobSummary(setAgentJobEnabled(id, args[0] === "enable")));
      return 0;
    }
    if (args[0] === "delete") {
      const id = args[1];
      if (!id) {
        return usage();
      }
      deleteAgentJob(id);
      writeJson({ deleted: true, id });
      return 0;
    }
    if (args[0] === "run-once") {
      const jobId = args[1]?.trim();
      if (!jobId) {
        return usage();
      }
      console.log(await runCronOnce(jobId, args.includes("--force")));
      return 0;
    }
    if (args[0] === "prune-slots") {
      writeJson({ deleted: pruneRunSlots() });
      return 0;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${detail}\n`);
    return 1;
  }
  return usage();
}
