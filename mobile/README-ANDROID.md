# Grey GodZilla Anime Tracker — Android APK

Full app port for private sideload (you + brother). **Free tools only.**

## Features (same as desktop)
- Today / Week / Month / Year schedules (AniList)
- Search anime, manga, manhwa, webtoon, manhua
- Favorites + completed history
- Watch progress resume
- Webhooks (when app is open)
- Stream lookup via AnimeHeaven (best with Capacitor native HTTP)

## One-time setup (free)

1. Install **Node.js LTS** — https://nodejs.org  
2. Install **Android Studio** (includes SDK + JDK) — https://developer.android.com/studio  
3. Open Android Studio once → install Android SDK Platform 34 + Build-Tools  

## Build APK

```bat
cd mobile
npm install
npx cap add android
npx cap sync android
cd android
gradlew.bat assembleDebug
```

APK output:

```
mobile\android\app\build\outputs\apk\debug\app-debug.apk
```

Copy that file to the phone (USB / Drive / Discord) and install (allow Unknown sources).

## Release (optional, still free, unsigned debug is fine for family)

```bat
gradlew.bat assembleRelease
```

For a signed release you’d create a free local keystore (no Google fee unless publishing on Play Store).

## Notes
- No paid services, no API keys (AniList is free).
- Data/favorites store on the device (`localStorage`).
- Discord webhooks work best while the app is open.
- If in-app video fails, use **Open on AnimeHeaven.me**.
