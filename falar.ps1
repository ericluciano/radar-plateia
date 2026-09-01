# falar.ps1 — fala um texto em voz alta NO VOLUME ATUAL do PC (nao mexe no volume master).
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File falar.ps1 -Arquivo "C:\tmp\frase.txt"
# O texto vem de ARQUIVO UTF-8 (nao de argumento) pra acentuacao nunca chegar corrompida.
# Voz: pt-BR-AntonioNeural (edge-tts). Fallback offline: SAPI pt-BR.
# Baseado em claude-stack/tools/avisar-voz/avisar-voz.ps1, SEM o bloco de volume.

param(
  [Parameter(Mandatory = $true)][string]$Arquivo,
  [string]$Voz = "pt-BR-AntonioNeural"
)

$ErrorActionPreference = "Stop"
$Texto = (Get-Content -Path $Arquivo -Encoding UTF8 -Raw).Trim()
if (-not $Texto) { Write-Output "vazio"; exit 0 }

# C:\tmp de proposito: %TEMP% do Eric tem espaco no caminho e quebra o ffmpeg.
if (-not (Test-Path "C:\tmp")) { New-Item -ItemType Directory -Path "C:\tmp" | Out-Null }
$tmp = "C:\tmp\radar-voz-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
$mp3 = "$tmp.mp3"
$wav = "$tmp.wav"

try {
  $usouNeural = $false
  $motivo = ""
  try {
    $ErrorActionPreference = "Continue"
    python -m edge_tts --voice $Voz --text $Texto --write-media $mp3 2>&1 | Out-Null
    if ((Test-Path $mp3) -and ((Get-Item $mp3).Length -gt 0)) {
      ffmpeg -y -i $mp3 -ar 22050 -ac 1 -af volume=2.0 $wav 2>&1 | Out-Null
      if ((Test-Path $wav) -and ((Get-Item $wav).Length -gt 0)) { $usouNeural = $true }
      else { $motivo = "ffmpeg nao gerou o wav" }
    } else { $motivo = "edge-tts nao gerou o mp3 (sem internet?)" }
  } catch { $usouNeural = $false; $motivo = $_.Exception.Message }
  finally { $ErrorActionPreference = "Stop" }

  if ($usouNeural) {
    (New-Object System.Media.SoundPlayer $wav).PlaySync()
    Write-Output "ok: falado com $Voz"
  } else {
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $ptbr = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'pt*' } | Select-Object -First 1
    if ($ptbr) { $s.SelectVoice($ptbr.VoiceInfo.Name) }
    $s.Volume = 100
    $s.Speak($Texto)
    Write-Output "ok: falado com SAPI (FALLBACK) - motivo: $motivo"
  }
}
finally {
  Remove-Item $mp3, $wav -ErrorAction SilentlyContinue
}
