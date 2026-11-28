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
- Each step says what's theirs right now ("yours.", "it'll be in your next order from our shop.", "it's
  ready! pick your pin at checkout, the next time you order.").

## Data (Firestore)
```
users/{uid}
  email, firstName, lastName, phone, createdAt   // older documents may have displayName instead of firstName
  charges: number            // current count toward 10, server-written only
  lifetimeCharges: number    // every pin they've registered
  earlyAccess: boolean       // set true the first time charges reach 3, never unset
  gift6Awarded: boolean      // set true the first time charges reach 6, never unset (first lap only)
  pendingGift6: boolean      // true until the owner ships the gift with their next order
  freePinAvailable: boolean  // true at 10 until the pin on us is used
  freePinUsed?: boolean      // the pin on us went out with an order
  gift6SentWith?: string     // the Square order the 6-pin extra went out with

users/{uid}/orders/{squareOrderId}  // note that this buyer started a checkout, for order history
  createdAt

users/{uid}/collection/{CODE}  // the pins they've registered, kept for good. server-written only
  slug, size, at
  on?, x?, y?, r?, z?        // where it sits on their pin board (on: false or missing = in the tray)

codes/{CODE}                  // one per card
  slug, size, batch, createdAt
  claimedBy?: uid, claimedAt?
  cancelled?: boolean
  free?: boolean             // the card for a pin on us: joins the collection, adds no step

users/{uid}/redemptions/{squareOrderId}  // a pin on us that was used: key, at
users/{uid}/locks/free_pin    // held while one pay press uses the pin on us: at

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

## Rewards (stage 3, built 2026-11-28)
The account's rewards are worked out from its count every time a card is registered or the collection is
opened (`rewardChanges`, `settleRewards` in `server/codes.js`), so they can't drift from the count.

### 3 pins: a first look at new pins
- `earlyAccess` goes true at 3 and stays true. My collection shows "yours."
- "collectors" on `/admin` lists everyone who has it, with a button to copy their emails.
- **Collectors first** (built 2026-11-28): each pin has a third switch in "products and square" on `/admin`
  (`settings/early_<square mode>`, `POST /api/admin/early`). On, the pin is for sale only to signed-in accounts
  with a confirmed email and `earlyAccess`. Everyone else sees it with its price, "with our collectors first.
  it'll be in the shop for everyone soon." and how to get a first look. The catalog marks it `early: true`; the
  page asks `/api/collection` whether this visitor has a first look (only when such a pin exists and they're
  signed in); checkout refuses anyone else (`error: "early"`). No price is given to search engines while it's on.
  The owner switches it off to let everyone buy. Pins only.

### 6 pins: a little extra with their next order
- `gift6Awarded` goes true at 6, once per person, and `pendingGift6` is true until it has gone out.
- In "orders to ship" on `/admin`, an order from that buyer (signed in at checkout, so the Square order
  carries `metadata.uid`) says "collector's extra". Marking the order shipped sets `pendingGift6` false and
  notes the order in `gift6SentWith`.
- A collector who checks out signed out never triggers it: it waits for a signed-in order.

### 10 pins: a pin on us
1. The count stops at 10. `freePinAvailable` is true at 10 until the pin on us has been used
   (`freePinUsed`). My collection says "it's ready! pick your pin at checkout, the next time you order."
   **The path doesn't start again yet**: the owner is still deciding how a second time round should work
   (2026-11-28). A pin registered after ten joins the collection and `lifetimeCharges`, not the count.
2. On `/checkout` (our own card form only, never Square's hosted page), a signed-in collector with a
   confirmed email and 10 or more sees "a pin on us" with a drop-down of pins on the shelf (no boards, no
   pre-orders). The page sends only the pin's key (`free_pin`); the quote says whether one is ready
   (`free_pin_ready`).
3. The server re-checks everything, needs one more of that pin on the shelf than is being bought, and adds
   it as its own line with no price: "collector's path pin: corgi pin", quantity 1, $0. No discount is ever
   put on the order and no price is marked down. There is always at least one paid line, so the pin never
   ships alone.
4. One pay press at a time may use it (`users/<uid>/locks/free_pin`, stale after 10 minutes). A declined card
   or any other "not paid" answer lets go of it.
5. Once the payment goes through: `freePinUsed` goes true, `users/<uid>/redemptions/<square order id>` is
   made, and the count stays at 10. One pin on us per collector, for now.
6. The line's note asks the owner to take one off that pin's count in Square (Square can't count a typed
   line), and to send it with a card from a "pins on us" batch: those cards (`free: true` on the code and
   its batch) add the pin to the collection without adding a step, so a free pin never earns a charge.

## Open questions for the owner
- **What happens after ten?** For now the count stops at 10 and the pin on us is used once. When the owner
  decides how a second time round works, `rewardChanges` and `useFreePin` are the two places to change.

## Resolved
- **Rewards (2026-11-28):** a first look is a "collectors first" switch per pin. The count is kept at a maximum of 10 with no reset yet. Stock for a pin on us is taken off by hand in Square.
- **Code cards (2026-11-28):** the code lives on a card that goes out with the pin, 8 characters, the first three for the pin. The card is the only way to earn a charge, on every channel. The QR code opens `/register` with the code filled in. The packing tool, serial stickers and `/p/<serial>` page are dropped.
- **Double counting (2026-10-25, simplified 2026-11-28):** each code can be registered once, and nothing else earns a charge. See "How charges arrive".
- **First-lap rewards (2026-10-25):** the 3 and 6 rewards happen once per person. The free pin at 10 repeats.
- **Wholesale (2026-10-25):** wholesale buyers never claim. Their customers redeem the codes. Wholesale is a Square customer group.
