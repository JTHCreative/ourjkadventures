# Reviews (owner steps)

People with an account and a confirmed email can rate any pup pin from 1 to 5 stars and add a short
note. Nothing shows on the site until you approve it. Approved reviews appear on that pin's panel
on the pup club page, and approved 4 and 5 star reviews that have words also appear in the "kind
words." section on the home page. That section stays hidden until there is at least one.

There is nothing to set up: reviews use the same Firebase project and Cloudflare settings as accounts.

## Photos on reviews (one-time setup, before this change goes live)
Reviewers can add up to 4 photos. The photos live in **Cloudflare R2**, Cloudflare's file storage (think
of it as a storage unit next to the website). It's free up to 10 GB, about 30,000 review photos.

**Do these steps before merging the photo change into `main`.** The website's settings point at a bucket
called `review-photos`. If the bucket doesn't exist yet, Cloudflare stops the deploy and the site keeps
running the previous version until you create it.

1. Open the Cloudflare dashboard and choose **Storage & databases** > **R2 Object Storage** in the left menu.
2. The first time only: Cloudflare asks you to turn R2 on and add a payment card. You stay on the free plan
   unless you go past 10 GB, and past that it's about 1.5 cents per GB a month.
3. Press **Create bucket**. Name it exactly `review-photos`. Leave location on **Automatic** and storage
   class on **Standard**. Press **Create bucket**.
4. Leave **Public access** off. The website hands out the photos itself, so it can keep waiting photos
   private until you approve them.
5. Merge the change. Once it deploys, a pin's review form shows **add photos.**

Until the bucket exists, review forms simply don't show the photo button. Nothing else changes.

To check on space: **R2 Object Storage** > **review-photos** > **Metrics**.

1. Sign in on the website as the owner and open **your account > shop settings** (or go to `/admin`).
2. Under **new reviews**, each waiting review shows its pin, stars, words, name and date.
   Photos show as small squares; tap one to see it full size.
3. Press **approve** to put it up (words and photos together), or **hide** to keep it off the site. A hidden review stays stored;
   its writer sees "we did not post this review" on the pin panel, with our email.
4. An approved review shows on the site within about 10 minutes. The server re-reads approved reviews at most every 10 minutes.

The Firebase console still works as a backup: **Firestore Database > Data > reviews**, then change a
review's `status` from `pending` to `approved` or `hidden`. To remove a review completely, delete its
document there.

## Your own product photos
When someone opens a pup on the board, a photos section shows under it: your own photos of that pup first, then every photo from its approved reviews.
To add yours:
1. Open `/admin` and find **product photos**.
2. Pick the product, choose one or more photos, and (optional, but kind) type a few words about them, like
   "the corgi pin on a denim jacket". Those words are read aloud to people who can't see the picture.
3. Press **upload**. They show under the board within about 10 minutes.
4. To take one down, press **remove** under it.

Up to 24 photos per product. They go in the same `review-photos` bucket, so there's nothing new to set up.

## What to approve
- Screen for spam, rudeness, private details (someone's address or phone), or things that aren't about the pin.
- For photos, also look for faces of other people, kids, house numbers, street signs, or anything that
  isn't theirs to share. If one photo is a problem, hide the review and write to them; they can post it
  again without that photo. (Approving or hiding covers the whole review: there's no approving just some photos.)
- **Don't hold back a review because it's low.** US rules (the FTC's rule on consumer reviews) treat
  hiding honest negative reviews as misleading. A 2-star review about a loose pin back is fair; reply
  to the person by email and fix the problem instead.
- Every approved rating counts toward the pin's average. Only the home page section picks out the
  4 and 5 star ones, and it doesn't claim to be all of them.

## Good to know
- One review per person per pin. If someone edits theirs, it goes back to `pending` and disappears
  until you approve it again.
- People can remove their own review from the pin panel, photos included. Deleting an account removes all
  of that person's reviews and photos.
- Before a photo leaves someone's phone, the page shrinks it and saves a fresh copy. That copy drops the
  hidden notes cameras keep inside photos, like where it was taken. The server checks again for anything left.
- Guests can add photos too, but can't see them again until you approve, since they have no sign-in.
- The name shown is the account's first name and last initial ("juniper h."), or "a collector" if
  they haven't given a name.
