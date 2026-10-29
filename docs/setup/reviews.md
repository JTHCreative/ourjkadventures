# Reviews (owner steps)

People with an account and a confirmed email can rate any pup pin from 1 to 5 stars and add a short
note. Nothing shows on the site until you approve it. Approved reviews appear on that pin's panel
on the pup club page, and approved 4 and 5 star reviews that have words also appear in the "kind
words." section on the home page. That section stays hidden until there is at least one.

There is nothing to set up: reviews use the same Firebase project and Cloudflare settings as accounts.

## Approving a review
1. Open console.firebase.google.com and choose **jk-adventures-website**.
2. Go to **Build > Firestore Database > Data**.
3. Click the **reviews** collection. Each review is named `<pin>_<account id>`, for example `corgi_Xy12...`.
4. Click a review to see its `rating`, `text`, `name` and `status`. New and edited reviews say `pending`.
5. Hover over the `status` field, click the pencil, change `pending` to `approved`, and press **Update**.
6. It shows on the site within about 10 minutes. The server re-reads approved reviews at most every 10 minutes.

To take a review down, change `status` to `hidden`. To remove it completely, click the three dots
next to the review and choose **Delete document**.

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
- To find waiting reviews quickly: on the **reviews** collection, click the filter icon and filter
  `status` == `pending`.
