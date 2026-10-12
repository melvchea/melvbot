import { evIntervals, type EvIntervalJson } from "./ev.js";
import { listEvSheetRows, liveEvCharges } from "./ev_rows.js";

export async function listEv(): Promise<EvIntervalJson[]> {
  return evIntervals(liveEvCharges(await listEvSheetRows()));
}
