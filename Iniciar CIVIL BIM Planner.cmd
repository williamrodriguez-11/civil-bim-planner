@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv-web\Scripts\python.exe" goto setup
if not exist "web\dist\index.html" goto setup
echo CIVIL BIM Planner
echo Abre http://127.0.0.1:8765 en tu navegador.
echo Para detener el servidor local, pulsa Ctrl+C.
".venv-web\Scripts\python.exe" -m uvicorn planner_api.main:app --host 127.0.0.1 --port 8765
if errorlevel 1 pause
exit /b
:setup
echo Consulta la preparacion del entorno web en README.md.
pause
exit /b 1
