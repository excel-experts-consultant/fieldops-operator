@echo off
title FieldOps Operator - Create Superadmin
echo.
echo ============================================
echo   FieldOps Operator - Superadmin Creator
echo ============================================
echo.

set /p FULLNAME=Enter Full Name:
set /p USERNAME=Enter Username:
set /p PASSWORD=Enter Password:

echo.
node make-admin.js "%FULLNAME%" %USERNAME% %PASSWORD%

echo.
echo Copy the command above and paste it to run.
echo.
pause
