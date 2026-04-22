@echo off
echo.
echo ============================================================
echo  BattleMech Sheet Server  ^|  http://localhost:3002
echo  Serving: \\HouserNAS\HouserFileBackup\AIBattletechProjects\Mech Sheets\Extracted Files
echo ============================================================
echo.
echo Keep this window open while using the Sheets feature.
echo.
python -m http.server 3002 --directory "\\HouserNAS\HouserFileBackup\AIBattletechProjects\Mech Sheets\Extracted Files"
pause
