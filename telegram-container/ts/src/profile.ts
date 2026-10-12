import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type Profile = Record<string, string>;

const PLACEHOLDER_RE = /\{\{([a-z0-9_]+)\}\}/g;

export function profilePath(): string {
  return path.join(process.env.MELVBOT_CONFIG_DIR ?? "/var/lib/melvbot/config", "profile.toml");
}

export function parseProfile(text: string): Profile {
  const profile: Profile = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([a-z0-9_]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line);
    if (match) {
      profile[match[1]!] = match[2]!;
    }
  }
  return profile;
}

export function loadProfile(filePath = profilePath()): Profile {
  return existsSync(filePath) ? parseProfile(readFileSync(filePath, "utf8")) : {};
}

/** Display names for the two owners, two cards and the vehicle; profile.toml keys owner1/owner2/card1/card2/vehicle. */
export type DisplayNames = { owner1: string; owner2: string; card1: string; card2: string; vehicle: string };

const DISPLAY_FALLBACKS: DisplayNames = { owner1: "Owner 1", owner2: "Owner 2", card1: "Card 1", card2: "Card 2", vehicle: "EV" };
let displayCache: { file: string; names: DisplayNames } | undefined;

/** Cached per profile path, so tests can point MELVBOT_CONFIG_DIR at a fixture. */
export function displayNames(): DisplayNames {
  const file = profilePath();
  if (displayCache?.file !== file) {
    const profile = loadProfile(file);
    const names = { ...DISPLAY_FALLBACKS };
    for (const key of Object.keys(DISPLAY_FALLBACKS) as (keyof DisplayNames)[]) {
      names[key] = profile[key] || DISPLAY_FALLBACKS[key];
    }
    displayCache = { file, names };
  }
  return displayCache.names;
}

/** Display label such as "Alice CardOne" for an owner and card id. */
export function cardLabel(owner: "owner1" | "owner2", card: "card1" | "card2"): string {
  const names = displayNames();
  return `${names[owner]} ${names[card]}`;
}

/** Regex alternation matching an owner's id or display name (case-insensitive use). */
export function ownerAlternation(): string {
  const names = displayNames();
  return ["owner1", "owner2", names.owner1, names.owner2].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

/** Vehicle name for user-facing prose (profile key vehicle). */
export function vehicleName(): string {
  return displayNames().vehicle;
}

/** Regex alternation for the profile vehicle (lowercased, escaped) or "ev"; just "ev" when the profile has none. */
export function vehicleAlternation(): string {
  const vehicle = (loadProfile().vehicle ?? "").trim().toLowerCase();
  return vehicle ? `${vehicle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|ev` : "ev";
}

/** True when typed text names the vehicle (profile value, any case) or is "ev". */
export function isEvName(text: string): boolean {
  const lower = text.trim().toLowerCase();
  const vehicle = (loadProfile().vehicle ?? "").trim().toLowerCase();
  return lower === "ev" || (vehicle !== "" && lower === vehicle);
}

export function applyProfile(text: string, profile: Profile, label: string): string {
  return text.replace(PLACEHOLDER_RE, (_whole, key: string) => {
    const value = profile[key];
    if (value === undefined) {
      throw new Error(`${label}: profile key "${key}" missing from profile.toml`);
    }
    return value;
  });
}
