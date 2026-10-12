import { listMergedAgenda } from "../reminders/agenda.js";
import {
  calendarCreate,
  calendarDelete,
  calendarList,
  calendarUpdate,
  tasksComplete,
  tasksCreate,
  tasksDelete,
  tasksList,
  tasksSearch,
  reminderDefaultEnd,
  tasksUpdate,
} from "../google/http.js";

const GOOGLE_USAGE =
  "usage: melvbot google calendar list [--query X] [--start/--end/--max/--calendar] | create|update|delete | melvbot google tasks list [--query X] [--completed] | create|update|complete|delete\n";

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

const DEFAULT_LIST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function defaultWindow(): { start: string; end: string } {
  const start = new Date();
  const end = new Date(start.getTime() + DEFAULT_LIST_WINDOW_MS);
  return { start: start.toISOString(), end: end.toISOString() };
}

const QUERY_BACK_MS = 90 * 24 * 60 * 60 * 1000;
const QUERY_FORWARD_MS = 365 * 24 * 60 * 60 * 1000;

/** Search window: 90 days back to a year ahead, so a keyword hit isn't limited to the 7-day list. */
export function queryWindow(now = Date.now()): { start: string; end: string } {
  return { start: new Date(now - QUERY_BACK_MS).toISOString(), end: new Date(now + QUERY_FORWARD_MS).toISOString() };
}

export async function runGoogleCli(args: string[]): Promise<number> {
  try {
    if (args[0] === "calendar" && args[1] === "list") {
      const rest = args.slice(2);
      const query = flag(rest, "--query");
      const window = query ? queryWindow() : defaultWindow();
      const from = flag(rest, "--start") ?? window.start;
      const to = flag(rest, "--end") ?? window.end;
      const max = Number(flag(rest, "--max") ?? (query ? "50" : "25"));
      const calendar = flag(rest, "--calendar");
      // Default (no --calendar): primary + family merged and time-sorted, like the digest.
      writeJson(
        calendar
          ? await calendarList(from, to, calendar, max, undefined, query)
          : await listMergedAgenda(from, to, max, undefined, query),
      );
      return 0;
    }
    if (args[0] === "calendar" && args[1] === "create") {
      const rest = args.slice(2);
      const summary = flag(rest, "--summary");
      const start = flag(rest, "--start");
      const kind = rest.includes("--reminder") ? "reminder" : "event";
      const end = flag(rest, "--end") ?? (kind === "reminder" && start ? reminderDefaultEnd(start) : undefined);
      if (!summary || !start || !end) {
        process.stderr.write(GOOGLE_USAGE);
        return 2;
      }
      writeJson(
        await calendarCreate({
          summary,
          start,
          end,
          location: flag(rest, "--location"),
          description: flag(rest, "--description"),
          attendees: flag(rest, "--attendees"),
          calendarId: flag(rest, "--calendar"),
          kind,
        }),
      );
      return 0;
    }
    if (args[0] === "calendar" && args[1] === "update") {
      const eventId = args[2];
      const rest = args.slice(3);
      if (!eventId) {
        process.stderr.write(GOOGLE_USAGE);
        return 2;
      }
      writeJson(
        await calendarUpdate(
          eventId,
          {
            summary: flag(rest, "--summary"),
            start: flag(rest, "--start"),
            end: flag(rest, "--end"),
            location: flag(rest, "--location"),
          },
          flag(rest, "--calendar") ?? "primary",
        ),
      );
      return 0;
    }
    if (args[0] === "calendar" && args[1] === "delete") {
      const eventId = args[2];
      if (!eventId) {
        process.stderr.write(GOOGLE_USAGE);
        return 2;
      }
      writeJson(await calendarDelete(eventId, flag(args.slice(3), "--calendar") ?? "primary"));
      return 0;
    }
    if (args[0] === "tasks" && args[1] === "list") {
      const rest = args.slice(2);
      const tasklist = flag(rest, "--tasklist") ?? "@default";
      const query = flag(rest, "--query");
      writeJson(
        query
          ? await tasksSearch(query, { completed: rest.includes("--completed"), tasklist })
          : await tasksList(Number(flag(rest, "--max") ?? "20"), tasklist),
      );
      return 0;
    }
    if (args[0] === "tasks" && args[1] === "create") {
      const rest = args.slice(2);
      const names = new Set(["--due", "--notes", "--tasklist"]);
      const title = rest.filter((part, index) => {
        const prev = rest[index - 1];
        return !names.has(part) && !(prev !== undefined && names.has(prev));
      })[0];
      if (!title) {
        process.stderr.write(GOOGLE_USAGE);
        return 2;
      }
      writeJson(
        await tasksCreate({
          title,
          due: flag(rest, "--due"),
          notes: flag(rest, "--notes"),
          tasklist: flag(rest, "--tasklist"),
        }),
      );
      return 0;
    }
    if (args[0] === "tasks" && args[1] === "update") {
      const taskId = args[2];
      const rest = args.slice(3);
      if (!taskId) {
        process.stderr.write(GOOGLE_USAGE);
        return 2;
      }
      writeJson(
        await tasksUpdate(
          taskId,
          {
            title: flag(rest, "--title"),
            due: flag(rest, "--due"),
            notes: flag(rest, "--notes"),
          },
          flag(rest, "--tasklist") ?? "@default",
        ),
      );
      return 0;
    }
    if (args[0] === "tasks" && args[1] === "complete") {
      const taskId = args[2];
      if (!taskId) {
        process.stderr.write(GOOGLE_USAGE);
        return 2;
      }
      writeJson(await tasksComplete(taskId, flag(args.slice(3), "--tasklist") ?? "@default"));
      return 0;
    }
    if (args[0] === "tasks" && args[1] === "delete") {
      const taskId = args[2];
      if (!taskId) {
        process.stderr.write(GOOGLE_USAGE);
        return 2;
      }
      writeJson(await tasksDelete(taskId, flag(args.slice(3), "--tasklist") ?? "@default"));
      return 0;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${detail}\n`);
    return 1;
  }
  process.stderr.write(GOOGLE_USAGE);
  return 2;
}
