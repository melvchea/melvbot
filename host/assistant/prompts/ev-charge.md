---
name: ev-charge
description: Use when logging or recalling a {{vehicle_model}} charge, odometer, kWh, charge history, efficiency (km/kWh), or the last/latest charge (not accessories, parts, or purchase shortlists).
always: false
---

# {{vehicle_model}} charge

This turn: run `melvbot sheet rules`, then `melvbot sheet ev add|list|void`. Follow this turn's Rules stdout plus the `list` JSON. The CLI dedupes and computes intervals, so never calculate or overwrite those.

Wrong row: `void <id>` using an `id` from this turn's `list`, then `list` again.

Recap from this turn's `list` JSON only, copying `km_per_kwh`, `distance_km` and `day_gap` from it. Format is a native GFM table with no bullets and no code fence: bold title `{{vehicle}} charge`, blank line, header `| Date | Charge | km/kWh |`, separator of at least three hyphens per column.
