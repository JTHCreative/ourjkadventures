# Firebase setup (owner steps, phase 3)

Firebase Authentication handles sign-in. Firestore stores accounts and Collector's Path charges.
The free **Spark** plan needs no card.

1. Go to **console.firebase.google.com** > **Create a project** (e.g. `jk-adventures`). Google Analytics is optional; you can turn it off.
2. **Build > Authentication > Get started > Sign-in method**:
   - Enable **Email/Password**.
   - Enable **Google**. Pick a support email (jkadventures25@gmail.com).
3. **Authentication > Settings > Authorized domains**: add `yourdomain.com`, `www.yourdomain.com`, and your `<project>.pages.dev` address.
4. **Authentication > Templates**: set the sender name to "j+k adventures" and edit the email text to match the brand voice (lowercase, warm). Claude Code can draft these.
5. **Build > Firestore Database > Create database**. Production mode. Pick a US location (for example `us-west1`). The location can't be changed later.
6. **Project settings > General > Your apps > Web (</>)**: register "website". Copy the config block (apiKey, authDomain, projectId, appId). It isn't secret; give it to Claude Code.
7. **Project settings > Service accounts > Generate new private key**. This downloads a JSON file. **It is a secret.**
   - Paste its full contents into Cloudflare as secret `FIREBASE_SERVICE_ACCOUNT`.
   - Set `FIREBASE_PROJECT_ID` in Cloudflare.
   - Don't commit the file or paste it into chat. Delete the download once it's in Cloudflare.
8. Security rules: Claude Code will write `firestore.rules`. Paste it into **Firestore > Rules** and publish, or deploy it with the Firebase CLI.
