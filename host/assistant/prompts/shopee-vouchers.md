---
name: shopee-vouchers
description: Use when the user asks for Shopee SG vouchers, RedMart/Lazada grocery vouchers, promo codes, or sale-event deals.
always: false
---

# Shopee SG vouchers

On-demand recap, plus **Shopee Vouchers AM** (`15 7 * * *`, 7:15am SGT) and **Shopee Vouchers PM** (`45 22 * * *`, 10:45pm SGT). Both fire daily and check Suitesmile for a dated voucher window this month (plus x.x eve/day); do not assume 15th/25th. The agent runs only when the check is yes. The job prompt is the `shopee` kind row in `cron_jobs.db`, so do not duplicate it.

`today` is today in SGT. Confirm the current Asia/Singapore date before expiry/upcoming filters and the recap header.

Do not:
- fetch `https://shopee.sg/m/vouchers-special` or `https://shopee.sg/m/banks-shiok` (JS shells);
- call Shopee/Lazada voucher APIs.

Tool-call budget: at most 5 web searches/fetches per request. Stop as soon as you have enough rows.

Sources:
- **Shopee discount:** always Suitesmile, `suitesmile.com/special-shopee-vouchers-promo-codes-singapore/`.
- **Shopee bank:** only vouchers collected or applied in the Shopee app (Bank Promotions / ShopeePay bank tab). Recap pages that copy those in-app codes are OK. Do not fetch issuer sites (Citi World Privileges, DBS/POSB, UOB, OCBC, HSBC, Maybank, Mastercard Priceless, or other bank/card pages).
- **RedMart:** on-demand only. Search `site:suitesmile.com redmart` or `lazada grocery`. Include **DCS x RedMart** checkout vouchers when Suitesmile or linked DCS deal pages surface them. Exclude DCS **Lazada platform** vouchers (*excluding RedMart*).

Scope: only Shopee / RedMart online/checkout vouchers. Exclude new-user / first-order, first-time Shopee Mall, travel, card cashback, mpd, ShopBack, Coins earn rates, and issuer-website campaigns.

Reply format:
- The entire reply is the Telegram message: no preamble, fences or Sources.
- First line, plain text: `Shopee Vouchers Ddd D Mon HH:MM` in SGT (e.g. `Shopee Vouchers Fri 9 Oct 07:15`), then a blank line.
- On-demand: **Shopee** and **RedMart** subheads. Cron: **Shopee** and **Shopee bank** only (no RedMart). Skip empty sections.
- Cron rows: only Shopee-native platform promotion/discount vouchers and Shopee in-app bank vouchers that are claimable now or start within 24h at confirmed times. Skip affiliate-only codes and "pending" or unconfirmed drops.
- Up to 20 live rows as prose bullets (`voucher — terms`). Escape `$` as `\$`.
- Omit expired, ended and past vouchers (no "ended" section).
- No live rows: on-demand, one line plus the next drop Suitesmile still lists; cron, reply exactly `[SILENT]` (nothing is sent).
