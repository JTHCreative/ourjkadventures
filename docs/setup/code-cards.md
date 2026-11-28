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
