---
name: weather
description: Use when the user asks for Singapore weather, rain chance, H/L, PSI, or morning-update weather bullets.
always: false
---

# Singapore weather

A sole line such as `singapore weather`, `what's the weather` or `weather in singapore` is answered with the NEA forecast and is not an agent turn. Never web search for a live forecast.

Schedule: morning and afternoon NEA still go out on the morning update and afternoon weather timers.
- No rain and Normal PM2.5: send at 7am, 11am and 3pm, each for the next 4 hours.
- Rain, a chance of rain, or PM2.5 worse than Normal: send each hour from 7am through 9pm.
- When rain has stopped and PM2.5 is back to Normal: send once more that hour.
- A new weather Telegram message deletes the previous weather message in that chat. Replying to an older weather message deletes that message.

Bullet: `• [conditions] in the {morning|afternoon} (XX% chance) over [areas], H:XX°C L:XX°C, PSI …`. When dry, drop `over [areas]` and the chance. Keep the `•`. Humidity is not rain chance.
