# Code cards

The little card that goes out with every pin. Each card has its own code. The buyer types it in (or scans the
card) and the pin joins their collection on the website. A card works once, for one account.

Think of it like a raffle ticket stub: it proves a real pin left our hands.

## Make a batch
1. Sign in and open `/admin`, then "code cards".
2. Pick the pin, the size (only the aussie and pomeranian have two) and how many cards, up to 200 at a time.
3. Press "make the codes". The new batch shows at the top of the list.
4. Press "download for printing". You get a spreadsheet file (a .csv) with one row per card:
   - **code**: what to print on the card, like `AUS7K2M9`
   - **pin** and **size**: which pin the card goes with
   - **link for the qr code**: what the card's QR code should open, like
     `https://ourjkadventures.com/register?code=AUS7K2M9`

You can download a batch again at any time.

## Print the cards
1. Give the file to whoever prints the cards, or use a design tool that fills a design in from a spreadsheet
   (Canva calls this "bulk create"; most printers call it "variable data").
2. On each card, show:
   - the code in print, big enough to read
   - a QR code made from that row's link
   - the words `ourjkadventures.com/register`, for people who'd rather type
3. Keep each pin's cards with that pin. An aussie card registers an aussie pin, whatever pin it's handed out with.

## Handing them out
- One card with every pin sold, and only with a pin sold.
- Tuck it in the bag or hand it over with the pin. Don't leave cards face up on the table: anyone who can see a
  code can register it.

## If a card is lost or misprinted
1. On `/admin`, "code cards", type its code under "look up a card".
2. Press "cancel this card". It stops working. "put this card back" undoes it.
3. A card someone has already registered can't be cancelled: the pin is in their collection.

## If a buyer says their card doesn't work
1. Look the card up on `/admin`. It says whether it's registered, when, and by which email.
2. "not registered yet" usually means a typo: codes never use 0, 1, the letter l or any vowel after the first
   three letters.
3. Registered by someone else: the code was seen before the pin was sold. Make a new card for them from a new
   batch.

# The collector's path rewards

Open `/admin`, "collectors", to see who has reached what.

## 3 pins: a first look at new pins
1. In "products and square", switch the new pin's "collectors first" on. It needs to be available (or on
   pre-order) and linked to its Square item, like any pin for sale.
2. Only collectors with a first look can buy it now. Everyone else sees it with its price and "with our
   collectors first. it'll be in the shop for everyone soon."
3. "collectors" lists everyone with a first look. "copy their emails" copies the list, so you can tell them.
4. When you're ready for everyone, switch "collectors first" off.

## 6 pins: a little extra with their next order
1. When that collector next orders while signed in, the order in "orders to ship" says "collector's extra".
2. Tuck the extra in (an upgraded backing card, a mini sticker sheet).
3. Press "mark shipped" as usual. That ticks the extra off.

## 10 pins: a pin on us
1. The collector picks the pin themselves at checkout. It shows on the order as its own line:
   "collector's path pin: corgi pin", with no price.
2. Pack that pin with the order.
3. **Take one off that pin's count in Square.** Square can't do it for a line like this one.
4. **Send it with a card from a "pins on us" batch.** In "code cards", tick "these go with pins on us" before
   pressing "make the codes". Those cards add the pin to their collection without adding a step.
5. Each collector gets one pin on us. Their count stays at 10 for now.

