@echo off
title Radar da Plateia
cd /d "%~dp0"

rem Python 3.12 (mediapipe nao roda no 3.13+). Tenta o launcher "py", depois o python do PATH.
set "PY=py -3.12"
py -3.12 -c "import sys" >nul 2>&1 || set "PY=python"

if not exist ".venv\Scripts\python.exe" (
    echo Primeira vez nesta maquina: instalando dependencias...
    %PY% -m venv .venv
    ".venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check -r requirements.txt
)

".venv\Scripts\python.exe" radar_plateia.py %*
if errorlevel 1 pause
