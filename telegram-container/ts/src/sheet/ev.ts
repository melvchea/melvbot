import { createHash } from "node:crypto";

import { moneyText } from "./spend_cycle.js";

export const EV_TAB = "ev_charges";
export const EV_HEADERS = [
  "id",
  "dedupe_key",
  "charge_type",
  "charged_on",
  "odometer_km",
  "energy_kwh",
  "site",
  "cost",
  "tags_json",
  "source_ref",
  "created_at",
  "updated_at",
  "voided_at",
] as const;

export const CHARGE_TYPES = ["full", "app_only", "partial", "public"] as const;
export type ChargeType = (typeof CHARGE_TYPES)[number];
const MS_PER_DAY = 86_400_000;

export type EvCharge = {
  id: number;
  charge_type: ChargeType;
  charged_on: string;
  odometer_km: number | null;
  energy_kwh: string | null;
  site: string | null;
  cost: string | null;
  tags: string[];
  dedupe_key: string;
  source_ref: string | null;
};

export type EvIntervalJson = {
  charge: EvCharge;
  distance_km: number | null;
  day_gap: number | null;
  km_per_kwh: string | null;
};

function digest(parts: unknown[]): string {
  const canonical = parts.map((part) => String(part).trim()).join("\x1f");
  return createHash("sha256").update(canonical).digest("hex");
}

export function isChargeType(value: string): value is ChargeType {
  return (CHARGE_TYPES as readonly string[]).includes(value);
}

export function evDedupeKey(parts: {
  chargeType: ChargeType;
  chargedOn: string;
  odometerKm: number | null;
  energyKwh: string | null;
  site: string | null;
}): string {
  if (parts.chargeType === "public") {
    return digest(["ev-public", parts.chargedOn, (parts.site ?? "").toLowerCase(), parts.energyKwh ?? ""]);
  }
  return digest(["ev", parts.chargeType, parts.chargedOn, parts.odometerKm ?? "", parts.energyKwh ?? ""]);
}

export function legacyNonpublicEvDedupeKey(parts: {
  chargedOn: string;
  odometerKm: number | null;
  energyKwh: string | null;
}): string {
  return digest(["ev", parts.chargedOn, parts.odometerKm ?? "", parts.energyKwh ?? ""]);
}

export function evIntervals(charges: EvCharge[]): EvIntervalJson[] {
  const ordered = [...charges].sort((left, right) => {
    if (left.charged_on !== right.charged_on) {
      return left.charged_on < right.charged_on ? -1 : 1;
    }
    return left.id - right.id;
  });
  const result: EvIntervalJson[] = [];
  let previous: EvCharge | null = null;
  for (const charge of ordered) {
    let distanceKm: number | null = null;
    let dayGap: number | null = null;
    let kmPerKwh: string | null = null;
    const odometer = charge.odometer_km;
    const eligible = charge.charge_type !== "public" && odometer !== null;
    if (odometer !== null && previous !== null && previous.odometer_km !== null && charge.charge_type !== "public") {
      distanceKm = odometer - previous.odometer_km;
      const start = Date.parse(`${previous.charged_on}T00:00:00Z`);
      const end = Date.parse(`${charge.charged_on}T00:00:00Z`);
      dayGap = Math.round((end - start) / MS_PER_DAY);
      if (charge.energy_kwh !== null) {
        kmPerKwh = moneyText(distanceKm / Number(charge.energy_kwh));
      }
    }
    result.push({
      charge,
      distance_km: distanceKm,
      day_gap: dayGap,
      km_per_kwh: kmPerKwh,
    });
    if (eligible) {
      previous = charge;
    }
  }
  return result;
}
