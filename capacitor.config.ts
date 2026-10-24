import type { CapacitorConfig } from "@capacitor/cli";

// The Android app is a native shell around the deployed Road Trip Mix site:
// sign-in (NextAuth) and the existing pages keep working unchanged, while
// native plugins add the local jam relay, hotspot and Spotify App Remote.
//
//   CAP_SERVER_URL=https://your-deployment.example npm run android:sync
//
// For local development against `next dev` on your machine, point it at your
// LAN address, e.g. CAP_SERVER_URL=http://192.168.1.20:3000 (cleartext is only
// allowed for http:// URLs).
const serverUrl = process.env.CAP_SERVER_URL;

const config: CapacitorConfig = {
  appId: "com.roadtripmix.app",
  appName: "Road Trip Mix",
  webDir: "android-web",
  server: serverUrl
    ? {
        url: serverUrl,
        cleartext: serverUrl.startsWith("http://"),
        errorPath: "index.html",
        // Spotify's login pages must open inside the app's WebView so the
        // NextAuth cookie lands in the right place.
        allowNavigation: ["accounts.spotify.com", "*.spotify.com", "*.scdn.co"],
      }
    : undefined,
  android: {
    allowMixedContent: false,
  },
};

export default config;
