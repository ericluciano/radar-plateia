# Radar da Plateia

Filma a plateia pela webcam e **avisa POR VOZ no PC** (sem apito) quando alguem fica **10s+ sem
olhar pra frente** — cabeca baixa (celular/teclado), virado pro lado ou sumiu da camera. O aviso
fala a posicao: "fileira X, cadeira Y contando da sua esquerda". 100% local: nao grava, nao
identifica, nao envia nada.

**Usar:** dois cliques em `RADAR.bat` (tem copia na area de trabalho). Janela abre com a camera;
caixa verde = atento, vermelha/laranja = disperso. Ao abrir, fala "radar de voz ativo".

**Teclas:** `m` mudo | `+`/`-` segundos da regra | `p` pausa | `q` sair.

Avisos ficam registrados em `logs/eventos.log`. Detalhes tecnicos: `CLAUDE.md`.
