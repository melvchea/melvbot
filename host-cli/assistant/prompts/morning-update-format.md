---
name: morning-update-format
description: Use for any headline list with link-checked article links; the 07:30 Morning Update cron itself is rendered in code (cron/morning_update.ts) in this layout.
always: false
---

# Morning Update — Telegram format

7:30am SGT cron: Calendar + Tasks + World/Tech/SG news. Singapore weather is a separate message from its own cron (rain and showers come only from the NEA 2-hour forecast; air quality is the 1-hour PM2.5 band, not the 24-hour PSI), so include no weather section.

## Output rules

Your entire reply is pasted into Telegram as-is, so:

- Output only the Morning Update message. No preamble ("Gathering...", "config paths...") and no footer (`---`, Sources, char counts, meta commentary).
- One title line: `Morning Update {Day} {D} {Mon} {HH:MM}` (SGT, 24h, e.g. `Morning Update Fri 10 Jul 07:30`), then a blank line, never `Morning Update — …` or `Today's Date:`.
- One blank line after the title and between sections, none within a section.
- No code blocks, raw JSON or pipe tables; use bullets.
- At most 4000 visible chars per Telegram message (headline text only; URLs sit hidden in `text_link` entities and do not count). Telegram silently drops anything over 4096.

## Template

The layout below is exact. Fill the placeholders and skip a section that is empty. Each news section holds up to 10 bullets (shown here as 3).

```
Morning Update [Day] [D] [Mon]

📅 Google Calendar:
[calendar_lines, verbatim]

📋 Google Tasks:
[task_lines, verbatim]

🌍 World News (last 24h):
- [headline](https://url)
- [headline](https://url)
- [headline](https://url)

💻 Tech News (last 24h):
- [headline](https://url)
- [headline](https://url)
- [headline](https://url)

🇸🇬 Singapore News (last 24h):
- [headline](https://url)
- [headline](https://url)
- [headline](https://url)
```

Section order is fixed: title, Calendar, Tasks (skip if none), World, Tech, Singapore.

## Calendar and Tasks

Script Output has `## calendar_lines` and `## task_lines`, already merged (primary {{email}} + family calendar), time-sorted, filtered (today's agenda; tasks due today or overdue only, by Asia/Singapore date) and formatted. Paste them verbatim under their headings; rewording, re-sorting, re-filtering or adding emoji/dates breaks the format. If a block is `(none)`, skip that section. The sender adds the task buttons.

Line shapes (already applied in the pre-formatted lines): timed `• HH:MM [emoji] title` (👶 for kid/family events), all-day `• All Day [emoji] title`, task `• title [due: YYYY-MM-DD]`. Limits: calendar ≤ 30 events, tasks ≤ 20; never dump the open task backlog.

## News headlines

- Format `- [headline text](https://url)`: the headline is the clickable link. The sender also accepts `- headline (https://url)` and converts both to hidden `text_link` entities. Never show bare URLs or `(https://...)` after headlines in the final message.
- Take every headline and URL from Script Output `news_world` / `news_tech` / `news_singapore` only. Those lists are already filtered to `age_hours < 24` and hold the resolved publisher URL. Copy each URL exactly: the sender swaps in the link-checked article URL and drops bullets whose URL is not in Script Output. Add no story that is not in that JSON, and never `web_search` for news (it returns day-old "top stories").
- Up to 10 bullets per section, each linking a different publisher article. With fewer than 10 items, print what exists and do not pad with older headlines.
- Distinct stories only: one headline per event or topic, never several angles, outlets or follow-ups for the same story. Pick the best headline per story from the prefetch list.
- Summarise, do not truncate. Script Output titles are the full cleaned headline; rewrite each into a complete headline of at most 10 words that makes sense alone. Cutting mid-phrase or taking the first N words leaves dangling "for" / "in" / "after".

Bad (same story repeated):
```
- Khamenei's sons attend funeral, successor absent
- Sons of Iran's leader attend funeral, Mojtaba absent
- Iran supreme leader absent as officials attend funeral
- OPEC+ raises oil output
```

Bad (truncated mid-phrase):
```
- Malaysia couple slapped with $1,600 fine each for
- US flags 40 economies, including Singapore, in China's
```

Good (complete, at most 10 words, distinct):
```
- Malaysia couple fined $1,600 each for public sex
- US flags Singapore in China transshipment list
- OPEC+ raises oil output as exports recover
```

## Data sources

Calendar and Tasks come from Script Output (above). News comes from `news_*` only: World = BBC World; Tech = The Register, then BBC Technology, Tech in Asia, The Verge; Singapore = CNA, Straits Times, Mothership.

## Send behaviour

Telegram send is five messages: (1) title + calendar, (2) Google Tasks if present, (3) World, (4) Tech, (5) Singapore. The sender drops any Singapore Weather block, strips any format-spec preamble, rewrites the title year from Asia/Singapore `now`, and splits even if you concatenate everything into one reply. Link previews are off (`telegram-no-link-previews`).
