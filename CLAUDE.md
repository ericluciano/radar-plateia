# radar-plateia

Objetivo: app local que filma a plateia de um evento pela webcam e apita no PC quando alguem dispersa (cabeca baixa em celular/teclado por tempo sustentado, ou rosto que some da camera). Pedido do Eric ao vivo na Imersao 01/09/2026.

## Escopo
- Deteccao de rosto MediaPipe full-range + varredura em 4 quadrantes (tiles) pra pegar rosto pequeno no fundo da sala.
- "Cabeca baixa" = proxy geometrico (distancia vertical nariz-olhos / distancia entre olhos) comparado a um baseline auto-calibrado POR ROSTO nos primeiros 3s — robusto a altura da camera e a pessoa.
- Disperso = cabeca baixa sustentada 6s+ (ajustavel com +/-) OU rosto estavel que sumiu (ghost, pessoa olhou totalmente pra baixo).
- Apito winsound (2 tons) com cooldown de 12s; teclas m/p/+-/1-9; log de apitos em logs/eventos.log.

## Fora de escopo (de proposito)
- NAO grava video, NAO tira foto, NAO identifica pessoas, NAO manda dado pra fora. Privacidade by design — manter assim.
- Deteccao de "mexer no teclado" por maos/movimento: v2, se precisar.

## Comandos
- Rodar: `RADAR.bat` (auto-cria venv na primeira vez em maquina nova) ou `.venv/Scripts/python.exe radar_plateia.py`
- Teste sem janela: `.venv/Scripts/python.exe radar_plateia.py --selftest 100`
- Flags: `--cam N`, `--segundos X`, `--minimo N`, `--no-tiles`, `--width/--height`

## Gotchas (pagos com incidente nesta entrega)
- **mediapipe 1.x REMOVEU mp.solutions** (API legada). Fixar `mediapipe==0.10.21` — e a ultima com FaceDetection full-range embutida sem download de modelo.
- Misturar `opencv-python` 5.x com `opencv-contrib-python` 4.x quebra o cv2 na desinstalacao (pacotes dividem a pasta cv2). Usar SO `opencv-contrib-python==4.11.0.86` + `numpy==1.26.4` (mediapipe 0.10 exige numpy<2). Venv isolado de proposito — nao instalar no Python global.
- Camera no Windows: abrir com `cv2.CAP_DSHOW` (MSMF trava/demora). Warm-up de ~10 reads antes de desistir.
- `cv2.putText` (fonte Hershey) NAO renderiza acento — texto de tela sem acentuacao.
- O apito sai na SAIDA DE AUDIO ATIVA do PC: se o som estiver roteado pra caixa/telao do evento, a plateia ouve o apito.
