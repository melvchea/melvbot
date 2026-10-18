---
name: telegram-media
description: Use when handling Telegram photo OCR, ,list photo import, or sole-line image generation.
always: false
---

# Photo OCR and image generation

None of these start an agent turn.

**Photos and OCR**
- `,list` / `,l` taps are `callback_query` (`sl:`), never `.voice`. `,list` photo import is MiniMax (`MINIMAX_API_KEY`).
- Sole-line OCR prose (`ocr`, `ocr this`, `please ocr the photo`, etc.) runs default MiniMax OCR on the remembered photo.
- A photo or supported image file is read by MiniMax-M3 (`captionImage`: instruction text, image data URL, `detail: default`, `thinking: adaptive` so the model reasons only when the question needs it) when the instruction is the caption or the next text message. The read does not block later updates. OCR stays `thinking: disabled`.
- A photo with no caption stays remembered until that next text, `,list` or OCR.

**Image generation**
- Image prose (`generate an image of …`, `make a picture of …`, `draw me a photo of …`, `please create an illustration of …`, `imagegen …`, optional `can you` / `could you` / trailing `please`) is a Claude turn. No image-generation tool exists now: say so, and do not curl MiniMax.
- `,imagegen` / `,ig` reply `not a command`.
- A second line, or a line with no image noun and no `imagegen`, stays a normal prompt.
