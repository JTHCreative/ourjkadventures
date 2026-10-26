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
7. **Registration codes**: one hidden code per core-catalog pin. Single use, first registration wins. Hidden in packaging until opened.

## How charges arrive
**Every charge comes from claiming a registration code.** One pin, one code, claimed once. That's the
single rule that prevents double counting.

| Channel | Who claims the code | When |
|---|---|---|
| Our site, signed in | automatically, for the buyer | when the owner packs the order and scans the pin's serial |
| Our site, signed out | the buyer, later | they use "redeem code" on `/account` with the code inside the packaging |
| Our booth, buyer has an account | automatically | owner scans the serial and enters the buyer's email at the sale |
| Our booth, no account | the buyer, later | "redeem code" |
| Etsy, Amazon, retail partners | the end customer | "redeem code" |
| Wholesale orders (B2B) | nobody at sale time | codes ship unclaimed; the retailer's customer redeems later |

Once a code is claimed, by either route, it is dead. A signed-in web buyer who also tries to type
the code from their package gets "this pin is already on your path."

### Wholesale
Wholesale buyers never claim codes. They're reselling, so the pins they buy keep their codes for the
end customer. The packing tool and booth mode never auto-claim on a wholesale order. Mark wholesale
buyers with a **"wholesale" customer group in Square**; the server skips any order whose customer is in
that group. Safeguard: an account that redeems an unusual number of codes (e.g. more than 20 in a
day) is flagged for the owner to review. It isn't blocked automatically.

### Serial vs code
Each packaged pin has two identifiers:
- a **serial** printed on the outside as a **QR code** on the bag sticker. Not secret. Only the owner's packing tool can act on it. The QR encodes a URL, `https://<domain>/p/<serial>`: a customer who scans it lands on that pin's page; the packing tool reads the serial out of the same URL.
- the **code** hidden inside, revealed when opened. Secret. Customers redeem this one.

The server maps serial → code. That's how the packing tool can claim the right hidden code for a
signed-in buyer without opening the package.

### Packing tool (`/admin/pack`, owner only)
- Owner signs in with an account that has an `admin` custom claim.
- Lists paid web orders that have a signed-in buyer (`metadata.uid`) and pins not yet linked.
- Owner scans each pin's serial. The server checks the serial's product matches a line in that order, claims the code for the buyer and adds the charge. Works on a phone camera.
- Booth mode: scan serial(s), enter the buyer's email. If it matches a verified account, claim. If not, do nothing, and the buyer can redeem later.

## Data (Firestore)
```
users/{uid}
  email, displayName, createdAt
  charges: number            // current count toward 10, server-written only
  lifetimeCharges: number
  earlyAccess: boolean       // set true the first time charges reach 3, never unset
  gift6Awarded: boolean      // set true the first time charges reach 6, never unset (first lap only)
  pendingGift6: boolean      // true until the owner ships the gift with their next order
  freePinAvailable: boolean  // true at 10 until redeemed

users/{uid}/ledger/{entryId}  // append-only history, server-written only
  type: "earn" | "redeem" | "adjust"
  source: "web" | "booth" | "code" | "owner"
  ref: string                // Square order ID, code hash, or note
  slug?: string
  createdAt

codes/{sha256(code)}          // never store the plain code
  slug, batch, serial, createdAt
  claimedBy?: uid, claimedAt?
  claimedVia?: "redeem" | "pack" | "booth" | "free"
  orderId?: string           // Square order, when claimed at packing or booth

serials/{serial}              // server-only lookup, for the packing tool
  codeHash, slug

processedEvents/{squareEventId}  // webhook idempotency
```
Ledger entry ID = the code hash, so a code can only ever produce one charge no matter how many times something retries.

## Security
- Firestore rules: a signed-in user may **read** `users/{their uid}` and its `ledger`. Nobody writes from the browser. `codes` and `processedEvents` are server-only.
- All writes go through Pages Functions using the service account.
- `/admin/*` routes and their APIs require a verified Firebase token with the `admin` custom claim.
- A serial alone can never be redeemed by a customer. Only the admin packing endpoint accepts serials.
- Code registration is rate-limited per account (e.g. 10 tries per hour) so codes can't be guessed.
- Code format: 10 characters from an unambiguous alphabet (no 0/O, 1/I/L), shown as `XXXXX-XXXXX`.

## Free pin redemption flow
1. Account page shows "your free pin is ready" when `freePinAvailable`.
2. In the bag, if there's at least one paid item, offer "add your free pin" with a pin picker (core catalog only).
3. `/api/checkout` re-checks everything server-side, adds the free pin as a $0 line ("collector's path pin"), and records a **pending** redemption with the order ID.
4. At packing, the free pin's serial is scanned like any other, but its code is marked **void** (claimedVia "free"), not credited, so a free pin never earns a charge.
5. On the paid webhook: finalize (charges = 0, freePinAvailable = false, ledger "redeem"). If the checkout is abandoned, the pending hold expires after 24 hours.

## Open questions for the owner
- None right now.

## Resolved
- **Double counting (2026-10-25):** each code can be claimed once. Signed-in web buyers get their pin's code claimed automatically at packing. Everyone else uses "redeem code". See "How charges arrive".
- **First-lap rewards (2026-10-25):** the 3 and 6 rewards happen once per person. The free pin at 10 repeats.
- **Wholesale (2026-10-25):** wholesale buyers never claim. Their customers redeem the codes. Wholesale is a Square customer group.
- **Sticker (2026-10-25):** QR code linking to `/p/<serial>`.
