// Paste the config object from:
//   Firebase console -> Project settings -> General -> Your apps -> Web app
//
// These values are NOT secrets. Firebase web config is public by design —
// every visitor's browser downloads it. What protects your data is Google
// sign-in plus the rules in firestore.rules, not hiding this file.

export const firebaseConfig = {
  apiKey: "PASTE_YOUR_API_KEY",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.firebasestorage.app",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000000000000000000000"
};
