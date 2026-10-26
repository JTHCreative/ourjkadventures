---
description: Add a new pin or product to the shop
argument-hint: <name, series, price, image path>
---
Add a new product: $ARGUMENTS

1. Pick a lowercase, hyphenated slug. Confirm the series (pup club, hometown series, chinese zodiac, boards, limited run). Core catalog = pup club, hometown, zodiac.
2. Add it to the product data (`site/products.json` today; Square catalog plus site content after phase 2) with price in cents. Never add a sale or compare-at price.
3. Convert the image to webp, about 900px, into the pins image folder.
4. Write any customer-facing text in the brand voice (`docs/brand-voice.md`): lowercase, warm, specific, no exclamation marks. Show me the copy before committing.
5. Make sure it appears where it should (pup board, collection page) and can be added to the bag and checked out in sandbox.
