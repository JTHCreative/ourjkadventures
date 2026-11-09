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
   - Enable **Google**. Set the support email to ourjkadventures@gmail.com.
2. **Authentication > Settings > Authorized domains**: add `ourjkadventures.com` and `www.ourjkadventures.com`.
   (`localhost` and the firebaseapp.com address are there already.) If you use Cloudflare preview
   links to test a branch, add that `workers.dev` address too.
3. **Authentication > Settings > Password policy** (optional): set the minimum length to 8 to match
   the site's own check.
4. **Authentication > Templates**: see "account emails" at the end of this page.
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

## The owner's page (/admin)
`/admin` is where you open and close the shop, link website products to Square items, and approve
reviews. It isn't in any menu. When you're signed in as the owner, your account page shows a
**shop settings** link. Anyone else who finds `/admin` sees only "this page is for the shop owner."

Like a staff door with a guest list: Firebase proves who you are, and Cloudflare holds the list.
14. In **Cloudflare > Workers & Pages > ourjkadventures > Settings > Variables and Secrets**, add
    **`ADMIN_EMAILS`**, type **Text**, value `ourjkadventures@gmail.com`. To add a second person later,
    separate addresses with commas. Press **Deploy**.
15. Your email must be **confirmed** in Firebase. Signing in with Google confirms it automatically.
    If you use email and password instead, click the link in the confirmation email first.
16. **Publish the updated rules.** In the Firebase console, open **Build > Firestore Database > Rules**.
    Select everything in the editor and delete it, paste in the whole of `firestore.rules` from this
    repo, and press **Publish**. Nothing visible changes. The rules already blocked every browser, and
    they now also name the `settings` documents (the shop switch and the Square links) explicitly.
17. **Check it.** Open `ourjkadventures.com/admin` and choose **sign in with google** with
    ourjkadventures@gmail.com. You should see **shop settings.** with the shop switch, products and
    reviews. Then open `/admin` in a private window and sign in with a different Google account: it
    should say only "this page is for the shop owner."

The shop starts **closed**. It stays closed until you flip the switch on `/admin`, and it also counts
as closed whenever the website can't reach Firestore, so a hiccup never opens it by accident.
The switch lives in Firestore at `settings/shop` (`open: true` or `false`). Please change it on
`/admin` rather than in the console, so the change is recorded with your email and time.

## Account emails (2026-11-09)
"confirm your email", "choose a new password" and "confirm your new email" are sent by **our website**, through
Resend, in the same letterhead as the order emails (logo, cream card, red button, signed justin and kitty). Firebase
still makes each link and checks it when it's pressed, but hands it to us instead of sending its own plain email.
Nothing to set up for that beyond Resend (`setup/email.md`).

Firebase's own templates still matter in two cases, so make them match as far as the console allows:
- **Backup**: if Resend isn't set up, the day's 100 emails are used up, or our server has a hiccup, the browser asks
  Firebase to send its own email instead, so nobody is left without a link.
- **"your email was changed"**: once someone confirms a new email, Firebase itself emails the *old* address with a
  link to undo it. We can't send that one ourselves.

Steps, in the Firebase console > **Authentication** > **Templates**. Do each of the three email templates
(**Email address verification**, **Password reset**, **Email address change**):
1. Press the pencil.
2. **Sender name**: `j+k adventures`.
3. **From**: `noreply` @ the address shown is fine. (Optional: once you add `ourjkadventures.com` under
   **Customize domain**, it can come from `support@ourjkadventures.com` like the others. Firebase walks you through
   two DNS records in Cloudflare.)
4. **Reply to**: `support@ourjkadventures.com`.
5. **Subject** and **Message** as below. Firebase fills in the words in `%...%`. Some templates don't let you change
   the message (Firebase locks it on some, to stop spam). If the box is greyed out, just set the subject.
6. Press **Save**.

**Email address verification**
- Subject: `confirm your email`
- Message:
  ```
  <p>hi there,</p>
  <p>thanks for making an account with us! press the link to confirm this is your email, so we know it's really you.</p>
  <p><a href="%LINK%">confirm my email</a></p>
  <p>didn't make an account at ourjkadventures.com? you can ignore this email.</p>
  <p>justin and kitty<br>j+k adventures</p>
  ```

**Password reset**
- Subject: `choose a new password`
- Message:
  ```
  <p>hi there,</p>
  <p>someone (we hope it was you) asked to reset the password for your j+k adventures account. press the link to choose a new one.</p>
  <p><a href="%LINK%">choose a new password</a></p>
  <p>the link works for an hour. didn't ask? you can ignore this email, and your password stays the same.</p>
  <p>justin and kitty<br>j+k adventures</p>
  ```

**Email address change** (goes to the *old* address after a change)
- Subject: `the email on your account changed`
- Message:
  ```
  <p>hi there,</p>
  <p>the email on your j+k adventures account was just changed to %NEW_EMAIL%.</p>
  <p>if that was you, there's nothing to do. if it wasn't, <a href="%LINK%">press here to change it back</a>, then choose a new password. and write to us at support@ourjkadventures.com so we can help.</p>
  <p>justin and kitty<br>j+k adventures</p>
  ```

Firebase's emails can't show the logo or the red button, so they'll look plainer than ours. The words match, and in
day-to-day use people only see ours.

**Check it works** (after Resend is set up): on the site, use "forgot your password?" with your own email. The
email should come from support@ with the logo and a red "choose a new password" button, not from Firebase's
noreply address.

