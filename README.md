# Radar da Plateia

Filma a plateia pela webcam e **avisa POR VOZ no PC** (sem apito) quando alguem fica **10s+ sem
olhar pra frente** — cabeca baixa (celular/teclado), virado pro lado ou sumiu da camera. O aviso
fala a posicao: "fileira X, cadeira Y contando da sua esquerda". 100% local: nao grava, nao
identifica, nao envia nada.

**Usar:** dois cliques em `RADAR.bat` (tem copia na area de trabalho). Janela abre com a camera;
caixa verde = atento, vermelha/laranja = disperso. Ao abrir, fala "radar de voz ativo".

**Teclas:** `m` mudo | `+`/`-` segundos da regra | `p` pausa | `q` sair.

Avisos ficam registrados em `logs/eventos.log`. Detalhes tecnicos: `CLAUDE.md`.

## Versao web (a que vale hoje): radar.ericluciano.com.br
Codigo em `web/`: app de navegador com 6 modos (Atencao, Exercicio, Produtividade, Postura, Presenca e Seguranca/EPI),
varias cameras na mesma tela, aviso por voz/apito, relatorio de sessao com CSV e medidor de ruido. Nada sai da maquina.
- Modo Seguranca: detecta pessoas e avisa quem esta sem colete de alta visibilidade (e, opcionalmente, capacete) ha mais de
  X segundos. Leitura por cor no torso/topo de cada pessoa; capacete e aproximado. Modelos MediaPipe embarcados (Apache 2.0).
- Quem e quem: postos/assentos mapeados por camera (arrasta um retangulo, da nome) e, opcionalmente, reconhecimento facial
  com consentimento (LGPD art. 11; cadastro pela propria camera, assinatura numerica so neste navegador, apagar imediato;
  motor face-api, MIT). O nome entra nos avisos e nas estatisticas.
- Relatorio: curva com pontos de queda, alerta da sala inteira, mapa de calor por fileira/cadeira, presenca (entradas,
  saidas, pico), grito/pico de ruido, CSV, impressao/PDF e historico de sessoes no navegador. Modo telao pra projetar.
- Testes unitarios: `cd web && npm test` | E2E: `python web/tests/e2e/run_all.py` (ver `web/tests/e2e/README.md`)
- Roteiro, decisoes tomadas e proximas entregas: `docs/ROADMAP.md`
