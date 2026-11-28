# Collector's Path: technical spec

Business rules come from `pricing-and-loyalty.md`. If this spec and that doc disagree, the doc wins:
stop and ask the owner.

## Rules to implement
1. Every **full-price, core-catalog pin** earns one **charge**. Core catalog = Pup Club, Hometown Series, Chinese Zodiac. Limited runs, seasonal drops, boards and wholesale never earn.
2. Rewards at **3** (early access to new drops), **6** (a small physical extra added to their next order, e.g. an upgraded backing card or mini sticker sheet), **10** (one free core-catalog pin). **The 3 and 6 rewards happen only the first time.** The free pin at 10 repeats on every lap.
3. **No reward is ever money off.** No partial redemption. Nine charges = pin ten is still full price.
4. Redeeming the free pin **resets the count to 0**. Nothing expires.
5. The free pin **must ride with a paid order**: it can only be added to a bag that already has at least one paid item, and only through our own site (never a partner or marketplace). The free pin itself earns nothing.
6. Charges can be **earned anywhere** (web, booth, marketplace, retail) but **spent only with us**.
7. **Code cards**: every core-catalog pin we sell goes out with a card that has its own code. Single use, first registration wins. A card only ever goes out with a pin.
8. **The collection is separate from the count.** Every registered pin stays in "my collection" for good. Redeeming the free pin sets the count back to 0 and takes nothing off the board.

## How charges arrive
**Every charge comes from registering a code card.** One pin, one card, registered once. That's the
single rule that prevents double counting, and it's the same on every channel: our site, our booth,
Etsy, a shop's shelf. Nothing is counted from an order, so a web buyer types their code like everyone
else (owner's decision, 2026-11-28; it replaced the packing tool and the serial stickers).

Once a card is registered it is dead. The same account trying again hears "this pin is already in
your collection"; another account hears that the card has been registered.

### The code
- 8 characters, like `AUS7K2M9`. The first three letters say which pin (`code` on each pin in
  `site/products.json`: AUS aussie, COR corgi, GOL goldie ...). The other five are random, from
  `23456789BCDFGHJKMNPQRSTVWXYZ`: no vowels, so a card can't spell a word by accident, and no 0, 1 or L,
  which look like other characters in print. About 17 million codes per pin.
- The card shows the code in print and as a QR code that opens
  `https://ourjkadventures.com/register?code=AUS7K2M9`, with the code already in the box. The page takes
  the code out of the address straight away.
- Typed codes are forgiving: capitals or not, with or without a dash or spaces.

### Registering (`/register`, and the box on `/account`)
1. The code goes in the box (typed, or from the QR code). The page says which pin the first three
   letters belong to ("an aussie pin!").
2. Signed in with a confirmed email: it registers.
3. Signed out: the page offers "continue with google", the create-account fields, or sign in, right
   there, then registers.
4. Email not confirmed yet: the code waits in that browser (`jka_code`) until the link is clicked.
5. The server (`POST /api/codes/register`, `server/codes.js`) answers registered, yours, taken, unknown
   or limit. Ten wrong guesses per account per hour.

### The owner's side (`/admin`, "code cards")
- Make a batch: pick a pin, a size and how many (up to 200). Download it as a spreadsheet file for
  the card printer: code, pin, size, the link for the QR code.
- Each batch shows how many of its cards are registered.
- Look up a card by its code: registered or not, when and by whom. A card nobody has registered can be
  cancelled (lost, misprinted) and put back.

### Wholesale
Wholesale buyers never register cards. They're reselling, so the cards go on to the end customer with
the pins. Safeguard (not built yet): an account that registers an unusual number of cards (e.g. more
than 20 in a day) is flagged for the owner to review. It isn't blocked automatically.

## My collection (`/collection`, built 2026-11-28)
An account page (noindex, no Meta Pixel), linked from `/account` and from the "it's yours" card on `/register`.
- **The Collector's Path** at the top: how many pins so far on the way to 10, a ten-step track, and what 3, 6
  and 10 bring. It moved here from the account page, which now shows the count and a link.
- **The pin board** (`site/assets/collection.js`): every registered pin. A new pin waits in a tray under the
  board; a tap puts it up. On the board a pin can be dragged, turned with its round handle, turned in steps
  with buttons, brought to the front, or taken back down to the tray. Keyboard: arrow keys move (shift for
  bigger steps), `[` and `]` turn. Two of the same pin are two pins.
- **Places are shares of the board, not pixels**: x and y are the pin's middle from 0 to 1, r the turn in
  degrees, z which is on top. The board is square, so it looks the same on a phone and a desk.
- **Saving**: a moment after the last move, `POST /api/collection/board` with only the pins that changed. The
  server only changes pins already in that person's collection, all or nothing; the board can't add or remove one.
- **Register a pin** box at the bottom: a newly registered pin drops straight into the tray.
- The rewards themselves (stage 3) aren't built: the page says what each step brings, but nothing tells the
  owner yet when someone reaches one.

## Data (Firestore)
```
users/{uid}
  email, firstName, lastName, phone, createdAt   // older documents may have displayName instead of firstName
  charges: number            // current count toward 10, server-written only
  lifetimeCharges: number    // every pin they've registered
  earlyAccess: boolean       // set true the first time charges reach 3, never unset
  gift6Awarded: boolean      // set true the first time charges reach 6, never unset (first lap only)
  pendingGift6: boolean      // true until the owner ships the gift with their next order
  freePinAvailable: boolean  // true at 10 until redeemed

users/{uid}/orders/{squareOrderId}  // note that this buyer started a checkout, for order history
  createdAt

users/{uid}/collection/{CODE}  // the pins they've registered, kept for good. server-written only
  slug, size, at
  on?, x?, y?, r?, z?        // where it sits on their pin board (on: false or missing = in the tray)

codes/{CODE}                  // one per card
  slug, size, batch, createdAt
  claimedBy?: uid, claimedAt?
  cancelled?: boolean

code_claims/{CODE}            // the lock: made once, by whoever registers first
  uid, at

code_batches/{id}             // one print run
  slug, size, count, claimed, createdAt, createdBy

code_tries/{uid}_{hour}       // wrong guesses, for the limit
  count
```
Registering is one all-or-nothing write: the lock, the card, the collection entry and the count. Firestore
refuses to make the lock twice, so a card can only ever produce one charge however many times something retries.

## Security
- Firestore rules: nobody reads or writes from the browser. Everything goes through the Worker with the service account.
- `/api/admin/*` checks the Firebase ticket and `ADMIN_EMAILS` on every request.
- Registering needs a signed-in account with a confirmed email, and is limited to 10 wrong guesses per account per hour.
- Codes are stored as they are, not hashed: the owner needs to download a batch again, and five random
  characters could be recovered from a hash by trying them all anyway (see `decisions.md`).
- The Meta Pixel never loads on `/register`: its address can carry a code.

## Free pin redemption flow (stage 3, not built yet)
1. My collection shows "your free pin is ready" when `freePinAvailable`.
2. In the bag, if there's at least one paid item, offer "add your free pin" with a pin picker (core catalog only).
3. `/api/checkout` re-checks everything server-side, adds the free pin as a $0 line ("collector's path pin"), and records a **pending** redemption with the order ID.
4. The free pin goes out with a card from a "no charge" batch: registering it adds the pin to the collection but not to the count, so a free pin never earns a charge.
5. On the paid webhook: finalize (charges = 0, freePinAvailable = false). If the checkout is abandoned, the pending hold expires after 24 hours.

## Open questions for the owner
- None right now.

## Resolved
- **Code cards (2026-11-28):** the code lives on a card that goes out with the pin, 8 characters, the first three for the pin. The card is the only way to earn a charge, on every channel. The QR code opens `/register` with the code filled in. The packing tool, serial stickers and `/p/<serial>` page are dropped.
- **Double counting (2026-10-25, simplified 2026-11-28):** each code can be registered once, and nothing else earns a charge. See "How charges arrive".
- **First-lap rewards (2026-10-25):** the 3 and 6 rewards happen once per person. The free pin at 10 repeats.
- **Wholesale (2026-10-25):** wholesale buyers never claim. Their customers redeem the codes. Wholesale is a Square customer group.
