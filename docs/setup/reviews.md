# Reviews (owner steps)

People with an account and a confirmed email can rate any pup pin from 1 to 5 stars and add a short
note. Nothing shows on the site until you approve it on the admin page. Approved reviews appear on that pin's panel
on the pup club page, and approved 4 and 5 star reviews that have words also appear in the "kind
words." section on the home page. That section stays hidden until there is at least one.

There is nothing to set up: reviews use the same Firebase project and Cloudflare settings as accounts.

## Approving a review (the admin page)
1. Sign in on the site with **ourjkadventures@gmail.com**. "continue with google" is easiest, and it
   confirms the email automatically. If you use a password instead, confirm the email first: the
   account page shows a check mark next to it once it's confirmed.
2. On your account page, open **reviews**. (Only the shop account sees this link. Everyone else who
   finds `admin.html` is told it's only for the shop's own account, and the server refuses them.)
3. **waiting** lists new and edited reviews. For each one, press **approve.** or **hide.**
4. The **approved** and **hidden** tabs let you change your mind later, or send a review **back to waiting.**
5. Approved reviews show on the site within about 10 minutes. The server re-reads approved reviews at
   most every 10 minutes.

To let someone else approve reviews too, add a plain variable `ADMIN_EMAILS` in Cloudflare
(Workers & Pages > ourjkadventures > Settings > Variables and Secrets) with every address that should
have access, separated by commas, for example `ourjkadventures@gmail.com, helper@example.com`. Setting
it replaces the default, so keep the shop's own address in the list.

### In the Firebase console instead
The admin page is the easy way. If it's ever unavailable:
1. Open console.firebase.google.com and choose **jk-adventures-website**.
2. Go to **Build > Firestore Database > Data** and click the **reviews** collection. Each review is
   named `<pin>_<account id>`, for example `corgi_Xy12...`.
3. Click a review, hover over its `status` field, click the pencil, change it to `approved` (or
   `hidden`), and press **Update**.
To remove a review completely, click the three dots next to it and choose **Delete document**.

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
