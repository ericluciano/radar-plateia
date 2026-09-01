# radar-plateia

Objetivo: app local que filma a plateia de um evento pela webcam e AVISA POR VOZ no PC quando alguem fica 10s+ sem olhar pra frente (cabeca baixa, virado pro lado ou rosto que some), falando a posicao estimada ("fileira X, cadeira Y contando da esquerda do Eric"). Pedido do Eric ao vivo na Imersao 01/09/2026. v1 apitava; Eric mandou matar o apito (irritante) e trocar por voz com posicao — regra de 10s.

## v3 — app web (`web/`)

Port completo pro navegador (pedido do Eric 01/09/2026, ao vivo): SPA estatica em `web/` — HTML+JS puro, MediaPipe tasks-vision VENDORIZADO (wasm + blaze_face_short_range.tflite em `web/vendor/`, ~23MB, nada baixa de CDN e NENHUMA imagem sai da maquina). 5 modos clicaveis sobre o mesmo engine (Atencao, Exercicio, Produtividade, Postura, Presenca), aviso configuravel (voz speechSynthesis / apito WebAudio / silencioso), segundos da regra por modo, gap, volume, seletor de camera, espelho. Config persiste em localStorage (`radar.cfg.v1`). Hook de teste automatizado: `window.__radar.estado` (build, engineOk, tracks, erros).
- Testar local: servidor estatico com MIME certo pra `.mjs`/`.wasm` (python http.server pode servir .mjs como text/plain e quebrar o import — usar node ou vercel dev).
- Deploy alvo: Vercel `--prod` + dominio radar.ericluciano.com.br (gate de producao — so com OK do Eric).
- Auto-degrade: maquina lenta (>150ms/frame) desliga a varredura por tiles sozinha e loga no painel.

## Escopo
- Deteccao de rosto MediaPipe full-range + varredura em 4 quadrantes (tiles) pra pegar rosto pequeno no fundo da sala.
- "Nao olhando pra frente" = geometria nariz-olhos normalizada pela distancia interocular, DOIS eixos: pitch (cabeca baixa) e yaw (virado pro lado), ambos comparados a baseline auto-calibrado POR ROSTO nos primeiros 3s — robusto a altura da camera, posicao na sala e pessoa.
- Disperso = 10s+ sustentado (ajustavel com +/-) OU rosto estavel que sumiu (ghost) ha 10s+.
- Aviso = frase falada via falar.ps1 (edge-tts Antonio, fallback SAPI; texto vai por ARQUIVO UTF-8 pra acentuacao nao corromper; NAO mexe no volume master, diferente do avisar-voz). Worker serializado com gap minimo de 20s entre falas e 1 aviso por pessoa por episodio (re-avisa so depois de recuperar e dispersar de novo).
- Fileira/cadeira: agrupamento 1-D dos rostos por altura no quadro (linha de baixo = fileira 1, mais perto da camera); cadeira = ordem x da esquerda (visao da camera = visao do Eric de frente pra plateia). E ESTIMATIVA — sala sem grade perfeita erra.
- Log de avisos em logs/eventos.log; teclas m/p/+-.

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
