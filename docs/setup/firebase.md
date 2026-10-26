# Firebase setup (owner steps, phase 3)

Firebase Authentication handles sign-in: it keeps passwords and sends the verify and reset emails.
Firestore stores each customer's account details, and later their Collector's Path charges.
The free **Spark** plan needs no card.

Project: **jk-adventures-website**. The web config (apiKey, projectId and so on) is already in
`site/assets/account.js`. It isn't secret.

Do these in order. The sign-in pages won't work until steps 1 to 6 are done, so finish them before
the accounts work is merged to `main`.

## In the Firebase console (console.firebase.google.com, open jk-adventures-website)
1. **Build > Authentication > Get started > Sign-in method**:
   - Enable **Email/Password**. Leave "Email link (passwordless sign-in)" off.
   - Enable **Google**. Set the support email to jkadventures25@gmail.com.
2. **Authentication > Settings > Authorized domains**: add `ourjkadventures.com` and `www.ourjkadventures.com`.
   (`localhost` and the firebaseapp.com address are there already.) If you use Cloudflare preview
   links to test a branch, add that `workers.dev` address too.
3. **Authentication > Settings > Password policy** (optional): set the minimum length to 8 to match
   the site's own check.
4. **Authentication > Templates**: set the sender name to "j+k adventures" for each email. To make the
   emails match the site's voice, ask Claude Code to draft lowercase versions of the verify-email and
   password-reset text.
5. **Build > Firestore Database > Create database**. Choose **Production mode** and a US location
   (for example `us-west1`). The location can't be changed later.
6. **Firestore Database > Rules**: replace everything with the contents of `firestore.rules` from this
   repo, then press **Publish**. These rules block every browser. Only the website's server can read
   or write, using the key from step 7.

## The server's key (this one is secret)
7. **Project settings (gear icon) > Service accounts > Generate new private key**. A JSON file downloads.
   Treat it like a house key: never commit it, email it or paste it into a chat.
8. In **Cloudflare > Workers & Pages > ourjkadventures > Settings > Variables and Secrets**:
   - Add **`FIREBASE_SERVICE_ACCOUNT`**, type **Secret**. Paste the whole contents of the JSON file.
   - Add **`FIREBASE_PROJECT_ID`**, type **Text**, value `jk-adventures-website`.
   - Press **Deploy** (or Save) so the worker picks them up.
9. Delete the downloaded JSON file from your computer (and empty the trash).

## Check it works (after the accounts work is merged to main)
10. Open ourjkadventures.com, choose **sign in**, then **create an account**. Use your own email.
11. You should land on "hello, <your name>." and get a verify email. Click its link, then reload the account page: the email check should say "confirmed."
12. In Firebase, **Firestore Database > Data** should show a `users` collection with one document.
13. Sign out, sign back in with **continue with google**, then delete that account from the account page.
    The Firestore document and the user under **Authentication > Users** should both be gone.

If the account page says "we could not open your account just now", the Cloudflare values in step 8
are missing or mistyped. If sign-in itself fails with "something went wrong", recheck steps 1 and 2.
