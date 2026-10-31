# Reviews (owner steps)

People with an account and a confirmed email can rate any pup pin from 1 to 5 stars and add a short
note. Nothing shows on the site until you approve it. Approved reviews appear on that pin's panel
on the pup club page, and approved 4 and 5 star reviews that have words also appear in the "kind
words." section on the home page. That section stays hidden until there is at least one.

There is nothing to set up: reviews use the same Firebase project and Cloudflare settings as accounts.

## Approving a review
1. Sign in on the website as the owner and open **your account > shop settings** (or go to `/admin`).
2. Under **new reviews**, each waiting review shows its pin, stars, words, name and date.
3. Press **approve** to put it up, or **hide** to keep it off the site. A hidden review stays stored;
   its writer sees "we did not post this review" on the pin panel, with our email.
4. An approved review shows on the site within about 10 minutes. The server re-reads approved reviews at most every 10 minutes.

The Firebase console still works as a backup: **Firestore Database > Data > reviews**, then change a
review's `status` from `pending` to `approved` or `hidden`. To remove a review completely, delete its
document there.

## What to approve
- Screen for spam, rudeness, private details (someone's address or phone), or things that aren't about the pin.
- **Don't hold back a review because it's low.** US rules (the FTC's rule on consumer reviews) treat
  hiding honest negative reviews as misleading. A 2-star review about a loose pin back is fair; reply
  to the person by email and fix the problem instead.
- Every approved rating counts toward the pin's average. Only the home page section picks out the
  4 and 5 star ones, and it doesn't claim to be all of them.

## Good to know
- One review per person per pin. If someone edits theirs, it goes back to `pending` and disappears
  until you approve it again.
- People can remove their own review from the pin panel. Deleting an account removes all of that
  person's reviews.
- The name shown is the account's first name and last initial ("juniper h."), or "a collector" if
  they haven't given a name.
