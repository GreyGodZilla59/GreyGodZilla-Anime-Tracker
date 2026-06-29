@echo off
setlocal EnableExtensions
title Build Grey GodZilla Anime Tracker
cd /d "%~dp0"

for /f "delims=" %%V in ('python -c "from version import APP_VERSION; print(APP_VERSION)"') do set "APP_VERSION=%%V"
for /f "delims=" %%N in ('python -c "from version import APP_NAME; print(APP_NAME)"') do set "APP_NAME=%%N"
set "EXE_NAME=%APP_NAME% v%APP_VERSION%"

echo Building %EXE_NAME%...
echo.

python -m PyInstaller ^
  --noconfirm ^
  --onefile ^
  --windowed ^
  --icon "assets\greygodzilla_icon.ico" ^
  --name "%EXE_NAME%" ^
  --add-data "index.html;." ^
  --add-data "css;css" ^
  --add-data "js;js" ^
  --add-data "assets;assets" ^
  --hidden-import requests ^
  --hidden-import webhook_manager ^
  app.py

if %ERRORLEVEL% NEQ 0 (
  echo.
  echo Build failed.
  pause
  exit /b 1
)

echo.
echo Copying to final Distro...
call "C:\Scripts\Copy-To-FinalDistro.bat" "%~dp0dist\%EXE_NAME%.exe"
if %ERRORLEVEL% NEQ 0 (
  echo Warning: could not copy to final Distro ^(exe may be running^).
) else (
  echo Shipped to: C:\Scripts\final Distro\
)

echo.
echo Done! Your app is here:
echo   dist\%EXE_NAME%.exe
echo   Version: %APP_VERSION%
echo.
pause