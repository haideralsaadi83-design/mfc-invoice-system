/* =========================================================================
   Firebase configuration.

   The app works completely WITHOUT this file being filled in — cloud sync
   simply stays switched off and everything still runs locally. Fill it in
   to turn on shared, multi-user invoice tracking.

   Setup (about 5 minutes):
     1. Go to https://console.firebase.google.com and create a project.
     2. Build > Firestore Database > Create database > Production mode.
     3. Build > Authentication > Sign-in method > enable Google.
     4. Project Settings (gear) > Your apps > Web (</>) > register the app,
        then copy the firebaseConfig values it shows into FIREBASE_CONFIG below.
     5. Firestore > Rules > paste the contents of firestore.rules, and add
        your team's email addresses to the allowlist inside that file.

   NOTE: these values are NOT secrets. A Firebase web config is a public
   identifier — it is designed to ship in client code. What actually protects
   your data is the security rules in firestore.rules, which is why the
   allowlist lives there and not here.
   ========================================================================= */

window.FIREBASE_CONFIG = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
};

/* Shown in the UI so a rejected user gets a useful message instead of a raw
   permission error. The real enforcement is in firestore.rules — editing this
   list alone grants nobody access. Leave empty to skip the client-side hint. */
window.ALLOWED_EMAILS = [
  // 'someone@yourcompany.com',
];
