@echo off
REM ===================================================================
REM Docker Image Build Script (Windows)
REM ===================================================================
REM
REM Usage: build-docker.bat [version]
REM Example: build-docker.bat 1.0.0
REM
REM ===================================================================

setlocal enabledelayedexpansion

REM Version setting
set VERSION=%1
if "%VERSION%"=="" set VERSION=1.0.0

REM Image names
set IMAGE_NAME=code-quality-server
set FULL_IMAGE=%IMAGE_NAME%:%VERSION%
set TAR_FILE=%IMAGE_NAME%-%VERSION%.tar

echo.
echo ===================================================================
echo   Code Quality Server - Docker Build
echo ===================================================================
echo.
echo   Image: %FULL_IMAGE%
echo   Time:  %date% %time%
echo.
echo ===================================================================

REM Check Docker
docker version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Docker is not running.
    echo.
    echo Please install Docker Desktop or Rancher Desktop
    echo.
    echo After installation:
    echo   1. Start the application
    echo   2. Wait until container engine is ready
    echo   3. Run this script again
    echo.
    pause
    exit /b 1
)

echo.
echo [1/3] Building Docker image...
echo.
docker build -t %FULL_IMAGE% .

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Build failed!
    pause
    exit /b 1
)

echo.
echo [OK] Build successful: %FULL_IMAGE%

REM Show image info
echo.
echo [2/3] Image info:
docker images %IMAGE_NAME%:%VERSION%

REM Save to tar file
echo.
echo [3/3] Saving image to: %TAR_FILE%
echo       (This may take a few minutes...)
echo.

docker save -o %TAR_FILE% %FULL_IMAGE%

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to save image!
    pause
    exit /b 1
)

REM Get file size
for %%A in (%TAR_FILE%) do set SIZE=%%~zA
set /a SIZE_MB=%SIZE%/1024/1024

echo.
echo ===================================================================
echo   Build Complete!
echo ===================================================================
echo.
echo   Image:     %FULL_IMAGE%
echo   Tar file:  %TAR_FILE%
echo   File size: about %SIZE_MB% MB
echo.
echo   [How to deliver to CI/CD team]
echo   1. Send %TAR_FILE% file
echo   2. Send DEPLOYMENT.md document
echo.
echo   [Commands for operations team]
echo   docker load -i %TAR_FILE%
echo   docker run -d -p 3000:3000 --name code-quality %FULL_IMAGE%
echo.
echo ===================================================================
echo.

pause
endlocal