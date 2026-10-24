This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | yes | Spotify app credentials, used both for the primary login and for connecting additional accounts. |
| `NEXTAUTH_SECRET` | yes | Signs NextAuth session cookies and also derives the key used to encrypt connected-account tokens stored in cookies. |
| `NEXTAUTH_URL` | yes in production | Base URL of the deployment, used for OAuth redirect URIs. |
| `OPENROUTER_API_KEY` | optional | Server-wide fallback [OpenRouter](https://openrouter.ai) key for AI mix curation, used only when a signed-in user hasn't connected their own key on the Settings page. |
| `APPLE_MUSIC_TEAM_ID` / `APPLE_MUSIC_KEY_ID` / `APPLE_MUSIC_PRIVATE_KEY` | optional | Apple Developer "MusicKit" identifiers, used to sign the developer tokens Apple Music connections require. See [Apple Music setup](#apple-music-setup) below. Omit all three to leave Apple Music connections disabled. |
| `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` | optional | Same value as `SPOTIFY_CLIENT_ID`. Only needed for the Android app's **Connect Spotify app** (App Remote) button. |
| `CAP_SERVER_URL` | Android build only | URL of the deployed site the Android app wraps (see [Android app](#android-app)). |
| `APPLE_MUSIC_STOREFRONT` | optional | Apple Music storefront country code (e.g. `us`, `gb`) used when resolving Spotify-sourced tracks against the Apple Music catalog for cross-platform playlists. Defaults to `us`. |

In your Spotify app dashboard, add both `${NEXTAUTH_URL}/api/auth/callback/spotify` (NextAuth login) and `${NEXTAUTH_URL}/api/spotify-accounts/callback` (linking additional accounts) as redirect URIs.

No OpenRouter app registration is required for the OAuth PKCE connection flow described below — it works against any deployment's callback URL out of the box.

### Apple Music setup

Apple Music connections need an [Apple Developer Program](https://developer.apple.com/programs/) membership with a MusicKit identifier and a private key:

1. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list), register a MusicKit identifier and note your **Team ID**.
2. Under [Keys](https://developer.apple.com/account/resources/authkeys/list), create a new key with the MusicKit capability enabled. Note the **Key ID** and download the `.p8` private key file — it can only be downloaded once.
3. Set `APPLE_MUSIC_TEAM_ID`, `APPLE_MUSIC_KEY_ID`, and `APPLE_MUSIC_PRIVATE_KEY` (the full contents of the `.p8` file — literal `\n` line-break escapes are fine if your platform doesn't support multiline env vars).

Unlike Spotify, there's no redirect URI to register: the app signs a developer token server-side and the browser (via MusicKit JS) handles user authorization directly against Apple.

## Collaborative mixes

The **Collaborative Mix** page (linked from the header once signed in) lets you connect multiple Spotify and Apple Music accounts — e.g. everyone going on the road trip — and automatically builds a shared playlist from each person's current favorites (recently played, top tracks/heavy rotation, and recently added library tracks). A track favorited on both Spotify and Apple Music by different people is recognized as the same song and merged. Optionally, enable AI curation to have an LLM (via OpenRouter) pick and order the final tracklist for a requested vibe. The playlist can be created on either Spotify or Apple Music; tracks sourced from the other platform are best-effort matched against the destination's catalog by title and artist, and any that can't be matched are skipped and reported.

## Settings

The **Settings** page (linked from the header once signed in) is where connections and keys are managed:

- **Spotify accounts** — connect additional accounts and disconnect any you no longer want feeding into collaborative mixes. Your primary login account is always included and can't be disconnected here (sign out instead).
- **Apple Music accounts** — connect accounts via MusicKit JS's in-browser authorization (no redirect back to this app; a "music user token" is handed to us directly once you approve). Requires the `APPLE_MUSIC_*` env vars above.
- **OpenRouter** — connect your own OpenRouter account via its [OAuth PKCE flow](https://openrouter.ai/docs/use-cases/oauth-pkce) (no API key to copy/paste — you're redirected to OpenRouter to authorize, and a personal key is issued back to this app automatically), or paste an existing API key manually instead. Each signed-in user's key is stored independently; the `OPENROUTER_API_KEY` env var is only used as a fallback when no personal key is connected.

## Jam mode

**Jam** (header link) turns the road trip playlist into a live, shared one. Everyone in the car adds songs from their own phone or tablet — no Spotify account needed — and each person gets **one song slot per round**: the order is round-robin, so a person who queues five songs still only plays one per round. People can queue songs, edit and reorder their own queue, and the Spotify playlist updates immediately (a tail rewrite, so what's already played or playing is never disturbed).

How it works:

- The **host** (you, signed in with Spotify) runs the session. Their device holds the authoritative state, does the Spotify search for everyone, and keeps the playlist in sync.
- **Joiners** open a link or scan a QR code from the host. The page is served by the host device itself, so joiners need no internet and no app — a phone, a laptop or a tablet browser all work.
- Host and joiners talk over a **local network**: on Android the app starts a local-only hotspot (shown as a Wi-Fi QR code plus a join link and 4-letter code); in a browser you run the relay yourself (below).
- You can start a jam on a new playlist, on a playlist made by this app (the **Start a jam** button on a grouped playlist), or on any of your Spotify playlists. Songs already in the playlist keep playing after everyone's queued songs, so it never runs dry.
- The host can reorder the rotation, remove songs or people, and change the per-person queue limit.

**Host rules.** The host can turn these on from the console (joiners see them under *House rules* and get a specific message when something is refused):

- **Each song plays once** — a song that has already played this session can't be added again. It also matches the same title and artist on a different release (a reissue or a "greatest hits" copy).
- **Max songs per artist** and **per album** — counted either *in the queue* (what's playing or queued right now) or *this session* (including everything already played). A song with several credited artists counts toward each of them.
- **Songs per person** in the queue, and whether the same song may be queued twice at once.

Rules are checked when songs are added, so tightening one later doesn't remove what's already queued. They apply the same way to single songs and to albums/playlists.

**Building a queue.** Search has *Songs*, *Albums* and *Playlists* tabs. **Add all** puts a whole album or playlist (first 100 songs) into your queue in order, **🔀** adds it shuffled; anything the rules or your queue limit refuse is skipped and summarised ("Added 9. Skipped 3: 2 already played, 1 over the artist limit."). **Shuffle** and **Clear all** act on your own queue; the host can do either for anyone. Everything can still be reordered by dragging or with the arrows. Playlists must be readable with the host's Spotify account.

Rotation rules: a person who adds a song joins the next turn they haven't had yet — the current round if their position is still ahead of the playing song, otherwise the next round. Empty queues are skipped.

Jam sessions are saved on the host device, so you can close the app and resume.

### Running the host from a browser

```bash
npm run jam-relay          # builds the joiner page and starts the relay on :8787
```

Connect the machine to the car's Wi-Fi or hotspot, start a jam from the **Jam** page, and share the link/QR it shows. The relay accepts the host connection only from the same machine and, by default, only from `http://localhost:3000`; set `JAM_HOST_ORIGINS` (comma-separated) if you serve the app elsewhere, and `JAM_PORT` to change the port. Spotify's [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk) is available as a "Play through this browser" toggle on desktop browsers (Premium; Spotify doesn't support it on mobile browsers or Android WebView).

## Play history

Every song that plays during a jam is recorded on the host device (IndexedDB) with its full track metadata at the time (artists, album, release date, duration, popularity, ISRC, … — whatever Spotify returns), who added it, which round, which device played it, who was online, and whether it was played through or skipped. Open **History** (header link) to browse, filter to jam plays, export JSON, or clear it. Turn on "Also record what I play outside of jams" there to keep history while the app is open. Records are structured for later features that learn from this data.

## Android app

The Android app is a [Capacitor](https://capacitorjs.com) shell around the deployed site (so sign-in and every page work unchanged) plus native plugins in `android/app/src/main/java/com/roadtripmix/app/jam/`:

| Plugin | What it does |
| --- | --- |
| `JamRelay` | Starts the local-only hotspot and an embedded HTTP/WebSocket relay that serves the joiner page and carries jam messages. Runs in a foreground service so it keeps going while you're in Spotify. |
| `SpotifyRemote` | [Spotify App Remote SDK](https://developer.spotify.com/documentation/android): controls the installed Spotify app and reports track changes instantly, so the rotation and play history don't wait for the next poll. |

Build it (needs JDK 17+ and the Android SDK; set `ANDROID_HOME`):

```bash
CAP_SERVER_URL=https://your-deployment.example npm run android:build
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run android:sync` builds the joiner page and runs `cap sync`; open the `android/` folder in Android Studio to run on a device. The first Gradle build downloads the Spotify App Remote AAR from Spotify's GitHub release into `android/app/libs/` (git-ignored). Run the native relay's tests with `cd android && ./gradlew :app:testDebugUnitTest`.

Spotify dashboard setup for the app:

1. Under your app's **Android** settings, register package name `com.roadtripmix.app` and your signing certificate's SHA-1 fingerprint (`keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android`).
2. Add the redirect URI `roadtripmix://spotify-callback`.
3. Set `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` to the same client id (it is public by design) so the console can show **Connect Spotify app**.

Notes and limits:

- **Re-login once.** Jam mode adds Spotify scopes (`user-modify-playback-state`, `user-read-currently-playing`, `streaming`, …). Sign out and back in to grant them.
- The app needs the internet for Spotify (search and playlist edits happen on the host); joiners only need to reach the host. Android's local-only hotspot has no internet for joiners, which is fine for this design.
- Android needs Nearby devices (13+) or Location (12 and below, with Location turned on) permission to create a hotspot. If it can't, the console says why and the jam still works on any shared Wi-Fi.
- The jam engine runs in the app's WebView; the foreground service and Capacitor's keep-running default are what let it carry on in the background. If a vendor's battery saver kills it, exempt the app from battery optimisation.
- Spotify's playlist API can only remove items by URI and replace 100 at a time, so live updates delete and re-add the not-yet-played tail from the first change onward. Spotify clients usually pick this up within a second or two; the track that's playing is never touched.

## Tests

```bash
npm test                    # engine, sync, history, relay (with real sockets)
cd android && ./gradlew :app:testDebugUnitTest   # native relay
```

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
