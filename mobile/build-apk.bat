@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Build GGZ Anime APK

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

for /f "usebackq delims=" %%V in (`node -p "require('./package.json').version"`) do set "APP_VER=%%V"
if not defined APP_VER (
  echo Could not read version from package.json
  exit /b 1
)
echo Building GGZ Anime v%APP_VER%

echo.
echo [1/5] npm install...
call npm install
if errorlevel 1 exit /b 1

if not exist "android\" (
  echo [2/5] Adding Android platform...
  call npx cap add android
) else (
  echo [2/5] Android platform already present.
)

echo [3/5] Syncing web assets into Android project...
call npx cap sync android
if errorlevel 1 exit /b 1

echo [4/5] Building debug APK...
cd android
call gradlew.bat assembleDebug
if errorlevel 1 (
  echo.
  echo Build failed. Open Android Studio once and install SDK Platform 34 + Build-Tools, then re-run.
  exit /b 1
)
cd ..

set "APK=%cd%\android\app\build\outputs\apk\debug\app-debug.apk"
if not exist "%APK%" (
  echo Built APK missing: %APK%
  exit /b 1
)

echo [5/5] Shipping v%APP_VER% and removing older anime app builds...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ship-apk.ps1" -ApkPath "%APK%" -Version "%APP_VER%"
if errorlevel 1 exit /b 1

echo.
echo Install on phone: transfer APK ^> enable Unknown sources ^> open file.
echo Uninstall previous GGZ Anime first if Android blocks the update.
exit /b 0
