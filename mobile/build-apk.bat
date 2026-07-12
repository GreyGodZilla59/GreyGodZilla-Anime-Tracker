@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Build Grey GodZilla Anime Tracker APK

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required. Install free LTS from https://nodejs.org
  exit /b 1
)

where java >nul 2>&1
if errorlevel 1 (
  echo Java JDK is required. Install free Temurin/OpenJDK 17+ or Android Studio.
  exit /b 1
)

echo.
echo [1/4] npm install...
call npm install
if errorlevel 1 exit /b 1

if not exist "android\" (
  echo [2/4] Adding Android platform...
  call npx cap add android
) else (
  echo [2/4] Android platform already present.
)

echo [3/4] Syncing web assets into Android project...
call npx cap sync android
if errorlevel 1 exit /b 1

echo [4/4] Building debug APK...
cd android
call gradlew.bat assembleDebug
if errorlevel 1 (
  echo.
  echo Build failed. Open Android Studio once and install SDK Platform 34 + Build-Tools, then re-run.
  exit /b 1
)

set "APK=%cd%\app\build\outputs\apk\debug\app-debug.apk"
echo.
echo SUCCESS
echo APK: %APK%

if exist "C:\Scripts\Releases\Copy-To-FinalDistro.bat" (
  copy /Y "%APK%" "%TEMP%\Grey GodZilla Anime Tracker v1.4.0-android.apk" >nul
  call "C:\Scripts\Releases\Copy-To-FinalDistro.bat" "%TEMP%\Grey GodZilla Anime Tracker v1.4.0-android.apk"
)

echo.
echo Install on phone: transfer APK ^> enable Unknown sources ^> open file.
exit /b 0
