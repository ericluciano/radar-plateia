@echo off
title Radar da Plateia
cd /d C:\repos\radar-plateia

set "PY=C:\Users\Eric Luciano\AppData\Local\Programs\Python\Python312\python.exe"
if not exist "%PY%" set "PY=python"

if not exist ".venv\Scripts\python.exe" (
    echo Primeira vez nesta maquina: instalando dependencias...
    "%PY%" -m venv .venv
    ".venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check -r requirements.txt
)

".venv\Scripts\python.exe" radar_plateia.py %*
if errorlevel 1 pause
