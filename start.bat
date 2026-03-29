@echo off
echo.
echo  ==============================================
echo   KinVeda - Starting Local Development Server
echo  ==============================================
echo.

cd kinveda-backend

:: Check if node_modules exists
if not exist "node_modules" (
    echo  Installing dependencies...
    npm install
    echo.
)

:: Check if database exists
if not exist "data\kinveda.db" (
    echo  Initialising database...
    npm run init-db
    echo.
)

echo  Starting server on http://localhost:3001
echo  Press Ctrl+C to stop.
echo.
npm start
