export const TELEGRAM_VISIBLE_LIMIT = 4000;

const BYTES_PER_GB = 1073741824;

const FIELD_KEYS = new Set([
  "timestamp",
  "disk-root",
  "disk-tmp",
  "docker-build-cache",
  "mem-total-bytes",
  "mem-min-bytes",
  "mem-avg-bytes",
  "mem-max-bytes",
  "mem-docker-min-bytes",
  "mem-docker-avg-bytes",
  "mem-docker-max-bytes",
  "mem-top-rss-min-bytes",
  "mem-top-rss-avg-bytes",
  "mem-top-rss-max-bytes",
  "mem-top-comm",
  "disk-root-delta-bytes",
  "disk-tmp-delta-bytes",
  "docker-cache-delta-bytes",
  "updates",
  "upgrades",
  "held-back",
  "reboot",
  "status",
  "health",
]);

type ParsedReport = {
  fields: Map<string, string>;
  upgradedPackages: string[];
  heldPackages: string[];
  withdrawnPackages: string[];
  versionBumps: string[];
};

function parseMaintReport(raw: string): ParsedReport {
  const fields = new Map<string, string>();
  const upgradedPackages: string[] = [];
  const heldPackages: string[] = [];
  const withdrawnPackages: string[] = [];
  const versionBumps: string[] = [];
  let section: "none" | "upgraded" | "held" | "withdrawn" | "versions" = "none";

  for (const line of raw.split("\n")) {
    if (line === "upgraded-packages:") {
      section = "upgraded";
      continue;
    }
    if (line === "held-packages:") {
      section = "held";
      continue;
    }
    if (line === "withdrawn-packages:") {
      section = "withdrawn";
      continue;
    }
    if (line === "versions:") {
      section = "versions";
      continue;
    }
    if (line === "failure-details:") {
      section = "none";
      continue;
    }

    const fieldKey = line.match(/^([a-z0-9][a-z0-9-]*):/)?.[1];
    if (section !== "none" && fieldKey && FIELD_KEYS.has(fieldKey)) {
      section = "none";
    }

    if (section === "upgraded") {
      const trimmed = line.trim();
      if (trimmed && trimmed !== "none") {
        upgradedPackages.push(trimmed);
      }
      continue;
    }
    if (section === "held") {
      const trimmed = line.trim();
      if (trimmed && trimmed !== "none") {
        heldPackages.push(trimmed);
      }
      continue;
    }
    if (section === "withdrawn") {
      const trimmed = line.trim();
      if (trimmed && trimmed !== "none") {
        withdrawnPackages.push(trimmed);
      }
      continue;
    }
    if (section === "versions") {
      const trimmed = line.trim();
      if (trimmed && trimmed !== "no changes") {
        versionBumps.push(trimmed);
      }
      continue;
    }

    const index = line.indexOf(":");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    if (key.includes(" ")) {
      continue;
    }
    fields.set(key, line.slice(index + 1).trim());
  }

  return { fields, upgradedPackages, heldPackages, withdrawnPackages, versionBumps };
}

// Format ISO 8601 timestamp to "Ddd D Mon" (e.g., "Tue 6 Oct").
// Extracts the date part (YYYY-MM-DD) from the ISO string to preserve the local date,
// avoiding timezone conversion to UTC.
function formatDateFromTimestamp(timestamp: string): string {
  try {
    // Host stamps in UTC; render in SGT so a 03:00 SGT run isn't labelled the previous day.
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Singapore",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("weekday")} ${get("day")} ${get("month")} ${get("hour")}:${get("minute")}`;
  } catch {
    return "";
  }
}

function formatGbFromBytes(bytes: number): string {
  const gb = bytes / BYTES_PER_GB;
  const rounded = Math.round(gb * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-9) {
    return String(Math.round(rounded));
  }
  return rounded.toFixed(1);
}

function formatSignedDelta(bytes: number): string {
  const sign = bytes >= 0 ? "+" : "-";
  return `(${sign}${formatGbFromBytes(Math.abs(bytes))}GB)`;
}

function parseBytesField(fields: Map<string, string>, key: string): number | null {
  const raw = fields.get(key);
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function formatMinAvgMax(min: number, avg: number, max: number): string {
  return `Min:${formatGbFromBytes(min)}GB Avg:${formatGbFromBytes(avg)}GB Max:${formatGbFromBytes(max)}GB`;
}

function formatMemLine(fields: Map<string, string>): string | null {
  const total = parseBytesField(fields, "mem-total-bytes");
  const min = parseBytesField(fields, "mem-min-bytes");
  const avg = parseBytesField(fields, "mem-avg-bytes");
  const max = parseBytesField(fields, "mem-max-bytes");
  if (total === null || min === null || avg === null || max === null) {
    return null;
  }
  return `🧠 ${formatGbFromBytes(total)}GB Mem ${formatMinAvgMax(min, avg, max)}`;
}

function parseDiskRoot(diskRoot: string): { total: string; used: string } | null {
  const match = diskRoot.match(/^(\S+)\s+total\s+(\S+)\s+used$/);
  if (!match) {
    return null;
  }
  return { total: match[1], used: match[2] };
}

function formatDiskRootLine(fields: Map<string, string>): string | null {
  const diskRoot = fields.get("disk-root");
  if (!diskRoot) {
    return null;
  }
  const parsed = parseDiskRoot(diskRoot);
  if (!parsed) {
    return null;
  }
  const delta = parseBytesField(fields, "disk-root-delta-bytes");
  const deltaText = delta === null ? "" : ` ${formatSignedDelta(delta)}`;
  return `💾 ${parsed.total} Disk ${parsed.used}${deltaText}`;
}

function formatDiskTmpLine(fields: Map<string, string>): string | null {
  const diskTmp = fields.get("disk-tmp");
  if (!diskTmp) {
    return null;
  }
  const used = diskTmp.replace(/\s+used$/, "");
  const delta = parseBytesField(fields, "disk-tmp-delta-bytes");
  const deltaText = delta === null ? "" : ` ${formatSignedDelta(delta)}`;
  return `💾 /tmp ${used}${deltaText}`;
}

function formatDockerCacheLine(fields: Map<string, string>): string | null {
  const cache = fields.get("docker-build-cache");
  if (!cache) {
    return null;
  }
  if (cache === "unavailable") {
    return "🐳 Docker cache: unavailable";
  }
  const size = cache.split("/")[0]?.trim();
  if (!size) {
    return null;
  }
  const delta = parseBytesField(fields, "docker-cache-delta-bytes");
  const deltaText = delta === null ? "" : ` ${formatSignedDelta(delta)}`;
  return `🐳 Docker cache: ${size}${deltaText}`;
}

function formatRebootValue(raw: string | undefined): string {
  const value = (raw ?? "unknown").replace(/^reboot:/, "");
  if (value === "nil") {
    return "none";
  }
  return value;
}

function formatAptSummaryLine(fields: Map<string, string>): string {
  const updates = (fields.get("updates") ?? "unknown").replace(/^updates:/, "");
  const upgrades = (fields.get("upgrades") ?? "unknown").replace(/^upgrades:/, "");
  const heldBack = (fields.get("held-back") ?? "unknown").replace(/^held-back:/, "");
  const reboot = formatRebootValue(fields.get("reboot"));
  return `📦 updates ${updates} · upgrades ${upgrades} · held-back ${heldBack} · reboot ${reboot}`;
}

export function formatBumpLine(line: string): string | null {
  const colonArrow = line.match(/^([^:]+):\s+(.+?)\s+->\s+(.+)$/);
  if (colonArrow) {
    return `>${colonArrow[1].trim()}: ${colonArrow[2]} → ${colonArrow[3]}`;
  }
  const spaceArrow = line.match(/^(\S+)\s+(.+?)\s+->\s+(.+)$/);
  if (spaceArrow) {
    return `>${spaceArrow[1]}: ${spaceArrow[2]} → ${spaceArrow[3]}`;
  }
  const name = line.trim().split(/\s+/)[0];
  return name ? `>${name}` : null;
}

function collectUpgradeLines(upgradedPackages: string[], versionBumps: string[]): string[] {
  const lines: string[] = [];
  for (const pkg of upgradedPackages) {
    const formatted = formatBumpLine(pkg);
    if (formatted) {
      lines.push(formatted);
    }
  }
  for (const bump of versionBumps) {
    if (!bump.includes("->")) {
      continue;
    }
    const formatted = formatBumpLine(bump);
    if (formatted) {
      lines.push(formatted);
    }
  }
  return lines;
}

function buildListSection(header: string, items: string[], budget: number): { section: string; used: number } {
  if (items.length === 0 || budget <= 0) {
    return { section: "", used: 0 };
  }

  const lines = [header];
  let used = header.length;

  for (let i = 0; i < items.length; i++) {
    const line = items[i];
    const lineCost = line.length + 1;
    const remaining = items.length - i - 1;
    const trailer = remaining > 0 ? `\n… ${remaining} more` : "";

    if (used + lineCost + (remaining > 0 ? trailer.length : 0) <= budget) {
      lines.push(line);
      used += lineCost;
      continue;
    }

    if (remaining > 0) {
      const trailerLine = `… ${remaining} more`;
      const trailerCost = trailerLine.length + 1;
      if (used + trailerCost <= budget) {
        lines.push(trailerLine);
        used += trailerCost;
      }
    }
    break;
  }

  const section = lines.join("\n");
  return { section, used: section.length };
}

export function formatMaintReport(raw: string, limit = TELEGRAM_VISIBLE_LIMIT): string {
  const { fields } = parseMaintReport(raw);
  const timestamp = fields.get("timestamp");
  const dateStr = timestamp ? formatDateFromTimestamp(timestamp) : "";
  const titleSuffix = dateStr ? ` ${dateStr}` : "";
  const lines = [`Daily Maintenance${titleSuffix}`, ""];

  const status = fields.get("status") ?? "";
  const health = fields.get("health") ?? "unknown";
  if (status.includes("FAIL") || status.includes("WARN")) {
    lines.push(`⚠️Status: ${status}`);
  } else if (health.startsWith("FAIL")) {
    lines.push(`Health status: ${health}`);
  } else {
    lines.push("Health status: ok");
  }

  const mem = formatMemLine(fields);
  if (mem) {
    lines.push(mem);
  }
  const diskRoot = formatDiskRootLine(fields);
  if (diskRoot) {
    lines.push(diskRoot);
  }
  const diskTmp = formatDiskTmpLine(fields);
  if (diskTmp) {
    lines.push(diskTmp);
  }
  const docker = formatDockerCacheLine(fields);
  if (docker) {
    lines.push(docker);
  }
  lines.push(formatAptSummaryLine(fields));
  return clipMessage(lines.join("\n"), limit);
}

function clipMessage(message: string, limit: number): string {
  if (message.length <= limit) {
    return message;
  }
  return `${message.slice(0, limit - 1)}…`;
}

function formatListMessage(header: string, items: string[], limit: number): string | null {
  const { section } = buildListSection(header, items, limit);
  if (!section) {
    return null;
  }
  return clipMessage(section, limit);
}

export function formatMaintReportMessages(raw: string, limit = TELEGRAM_VISIBLE_LIMIT): string[] {
  const { upgradedPackages, heldPackages, withdrawnPackages, versionBumps, fields } = parseMaintReport(raw);
  const messages = [formatMaintReport(raw, limit)];
  const upgrades = formatListMessage(
    "Upgrades:",
    collectUpgradeLines(upgradedPackages, versionBumps),
    limit,
  );
  if (upgrades) {
    messages.push(upgrades);
  }
  const heldItems = heldPackages
    .map((pkg) => formatBumpLine(pkg))
    .filter((line): line is string => line !== null);
  const held = formatListMessage("Held back:", heldItems, limit);
  if (held) {
    messages.push(held);
  }
  const withdrawnItems = withdrawnPackages
    .map((pkg) => formatBumpLine(pkg))
    .filter((line): line is string => line !== null);
  const withdrawn = formatListMessage("Withdrawn:", withdrawnItems, limit);
  if (withdrawn) {
    messages.push(withdrawn);
  }
  return messages;
}
