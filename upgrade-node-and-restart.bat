@echo off
setlocal EnableDelayedExpansion

echo ================================================
echo   OpenClaw Node.js Upgrade & Gateway Restart
echo ================================================
echo.

:: Check if running as Administrator
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] Please run as Administrator
    pause
    exit /b 1
)

:: Step 1: Check current Node version
echo [Step 1] Checking current Node version...
node --version
set "CURRENT_NODE=%errorLevel%"

:: Step 2: Backup OpenClaw config
echo.
echo [Step 2] Backing up OpenClaw config...
set "BACKUP_DIR=%USERPROFILE%\.openclaw\backups"
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"
set "BACKUP_FILE=%BACKUP_DIR%\openclaw_config_backup_%date:~0,4%%date:~5,2%%date:~8,2%_%time:~0,2%%time:~3,2%%time:~6,2%.json"
set "BACKUP_FILE=%BACKUP_FILE: =0%"
copy /Y "%USERPROFILE%\.openclaw\openclaw.json" "%BACKUP_FILE%" >nul
if exist "%BACKUP_FILE%" (
    echo   Config backed up to: %BACKUP_FILE%
) else (
    echo   [WARNING] Config backup failed, but continuing...
)

:: Step 3: Check nvm availability
echo.
echo [Step 3] Checking Node version manager...

where nvm >nul 2>&1
if %errorLevel% equ 0 (
    echo   Found nvm - will use nvm to upgrade
    set "USE_NVM=1"
) else (
    echo   nvm not found - will download Node installer directly
    set "USE_NVM=0"
)

:: Step 4: Download and install Node 22.18.0 (LTS)
echo.
echo [Step 4] Downloading Node.js 22.18.0 (current LTS)...
set "TEMP_DIR=%TEMP%\openclaw_node_upgrade"
if exist "%TEMP_DIR%" rmdir /S /Q "%TEMP_DIR%"
mkdir "%TEMP_DIR%"

where curl >nul 2>&1
if %errorLevel% equ 0 (
    curl -L -o "%TEMP_DIR%\node_installer.msi" "https://nodejs.org/dist/v22.18.0/node-v22.18.0-x64.msi"
) else (
    powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.18.0/node-v22.18.0-x64.msi' -OutFile '%TEMP_DIR%\node_installer.msi'"
)

if not exist "%TEMP_DIR%\node_installer.msi" (
    echo [ERROR] Failed to download Node.js installer
    echo   Trying alternative download method...
    powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.18.0/node-v22.18.0-x64.msi' -OutFile '%TEMP_DIR%\node_installer.msi' -TimeoutSec 60"
    if not exist "%TEMP_DIR%\node_installer.msi" (
        echo [ERROR] Download failed after retry
        rmdir /S /Q "%TEMP_DIR%"
        pause
        exit /b 1
    )
)

echo   Download complete!

:: Step 5: Stop Gateway
echo.
echo [Step 5] Stopping OpenClaw Gateway...
npx openclaw gateway stop >nul 2>&1
timeout /t 3 /nobreak >nul
echo   Gateway stopped

:: Step 6: Install Node.js
echo.
echo [Step 6] Installing Node.js 22.18.0...
echo   (This may take a minute or two...)
msiexec /i "%TEMP_DIR%\node_installer.msi" /quiet /norestart
echo   Waiting for installation to complete...
timeout /t 30 /nobreak >nul

:: Step 7: Refresh environment and verify
echo.
echo [Step 7] Verifying installation...
set "PATH=%SystemRoot%\system32;%PATH%"
for /f "tokens=*" %%i in ('powershell -Command "& { $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User'); node --version }"') do set "NEW_NODE=%%i"
echo   New Node version: %NEW_NODE%

:: Step 8: Restart Gateway
echo.
echo [Step 8] Restarting OpenClaw Gateway...
npx openclaw gateway start
set "START_STATUS=%errorLevel%"

:: Step 9: Verify Gateway is running
echo.
echo [Step 9] Verifying Gateway status...
timeout /t 5 /nobreak >nul
npx openclaw gateway status >nul 2>&1
if %errorLevel% equ 0 (
    echo.
    echo ================================================
    echo   SUCCESS! Gateway is running
    echo ================================================
) else (
    echo.
    echo ================================================
    echo   [WARNING] Gateway may not be fully started
    echo   Please check manually with: npx openclaw gateway status
    echo ================================================
)

:: Cleanup
echo.
echo [Cleanup] Removing temporary files...
rmdir /S /Q "%TEMP_DIR%" 2>nul

echo.
echo Done. Press any key to exit...
pause >nul
