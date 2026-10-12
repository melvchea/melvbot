import type { EvIntervalJson } from "./ev.js";
import { listEv } from "./ev_list.js";
import { dateAt, sgDateString } from "./spend_prose.js";
import { vehicleAlternation, vehicleName } from "../profile.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const SHOW_RE = /^(?:show|list|recall)\s+(?:my\s+)?(?<subject>.+)$/i;
const TABLE_HEADER = "| Date | Charge | km/kWh |\n|:-----|:-------|-------:|";
const EV_SUBJECT_RE = (): RegExp => new RegExp(`^(?:${vehicleAlternation()}) (?:m6 )?charges?$`);

export function evEmpty(): string {
  return `No ${vehicleName()} charges.`;
}

function subjectOf(line: string): string | null {
  const subject = SHOW_RE.exec(line.trim())?.groups?.subject;
  if (!subject) {
    return null;
  }
  return subject.trim().replace(/\s+/g, " ").toLowerCase();
}

export function parseEvShowDirective(line: string): boolean {
  const subject = subjectOf(line);
  return subject !== null && EV_SUBJECT_RE().test(subject);
}

function dayLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    return iso;
  }
  const month = Number(match[2]);
  if (month < 1 || month > MONTHS.length) {
    return iso;
  }
  return `${Number(match[3])} ${MONTHS[month - 1]}`;
}

function cell(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

function chargeCell(row: EvIntervalJson): string {
  const charge = row.charge;
  const parts: string[] = [charge.charge_type];
  if (charge.odometer_km !== null) {
    parts.push(`odo ${charge.odometer_km}`);
  }
  if (charge.energy_kwh) {
    parts.push(`${charge.energy_kwh} kWh`);
  }
  if (charge.site) {
    parts.push(charge.site);
  }
  if (charge.cost) {
    const cost = charge.cost.trim().replace(/^\\/, "");
    parts.push(cost.startsWith("$") ? cost : `$${cost}`);
  }
  if (row.distance_km !== null) {
    parts.push(`${row.distance_km} km`);
  }
  if (row.day_gap !== null) {
    parts.push(`${row.day_gap}d`);
  }
  return parts.join(" · ");
}

export function formatEvShow(rows: EvIntervalJson[]): string {
  if (rows.length === 0) {
    return evEmpty();
  }
  const lines = rows.map((row) => {
    const efficiency = row.km_per_kwh ?? "";
    return `| ${cell(dayLabel(row.charge.charged_on))} | ${cell(chargeCell(row))} | ${cell(efficiency)} |`;
  });
  return [`**${vehicleName()} charge**`, [TABLE_HEADER, ...lines].join("\n")].join("\n\n");
}

export async function evShowReply(): Promise<string> {
  return formatEvShow(await listEv());
}

export type EvAddDirective = { chargedOn: string; odometerKm?: number; energyKwh: string; cost?: string };

const EV_ADD_RE = (): RegExp => new RegExp(`^(?:store|log|add|record)\\s+(?:my\\s+)?(?:${vehicleAlternation()})(?:\\s+m6)?\\s+(?:full\\s+)?charge\\s+(?<rest>.+)$`, "i");

/** Non-LLM "store ev charge [date] <odometer>km <energy>kWh [$cost]"; energy is required, anything unrecognised returns null. */
export function parseEvAddDirective(text: string, now: Date = new Date()): EvAddDirective | null {
  const rest = EV_ADD_RE().exec(text.trim())?.groups?.rest;
  if (!rest || /\n/.test(text.trim())) {
    return null;
  }
  const today = sgDateString(now);
  const tokens = rest.split(/\s+/);
  const out: Partial<EvAddDirective> = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const unit = /^(?<n>\d[\d,]*(?:\.\d+)?)(?<u>km|kwh)?$/i.exec(token);
    const next = tokens[i + 1]?.toLowerCase();
    const date = out.chargedOn === undefined ? dateAt(tokens, i, today) : null;
    if (date) {
      if (!date.iso) {
        return null;
      }
      out.chargedOn = date.iso;
      i += date.used - 1;
    } else if (unit?.groups) {
      const value = unit.groups.n.replace(/,/g, "");
      const kind = (unit.groups.u ?? (next === "km" || next === "kwh" ? next : "")).toLowerCase();
      if (!unit.groups.u && kind) {
        i += 1;
      }
      if (kind === "km" && out.odometerKm === undefined && /^\d+$/.test(value)) {
        out.odometerKm = Number.parseInt(value, 10);
      } else if (kind === "kwh" && out.energyKwh === undefined) {
        out.energyKwh = value;
      } else {
        return null;
      }
    } else if (/^\$\d[\d,]*(?:\.\d+)?$/.test(token) && out.cost === undefined) {
      out.cost = token.slice(1).replace(/,/g, "");
    } else {
      return null;
    }
  }
  return out.energyKwh === undefined ? null : { chargedOn: out.chargedOn ?? today, ...out, energyKwh: out.energyKwh };
}
