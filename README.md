# Radar da Plateia

App de navegador que lê a câmera **dentro do próprio computador** e transforma isso em contadores, avisos por voz e
relatório: quem está sem olhar pra frente numa aula, quem saiu do exercício, quanto foco há num escritório, quantas
pessoas estão na sala e quem está sem colete numa fábrica. Nenhuma imagem sai da máquina.

**[→ Como funciona o Radar da Plateia](https://ericluciano.github.io/radar-plateia/)** — a página do projeto, com o sistema explicado visualmente.

App no ar: **[radar.ericluciano.com.br](https://radar.ericluciano.com.br)** (é só abrir e liberar a câmera; nada é enviado).

## O que ele faz

- **Seis modos** sobre o mesmo motor: Atenção (aula/palestra), Exercício, Produtividade, Postura, Presença e Segurança (EPI:
  colete de alta visibilidade e, opcionalmente, capacete, lidos por cor).
- **Várias câmeras** na mesma tela, com nome de ambiente; o aviso fala o nome da câmera.
- **Avisos** por voz (escolha da voz do sistema), apito ou silenciosos, com tempo de tolerância ajustável por modo; alerta da
  sala inteira; grito/pico de ruído.
- **Quem é quem**: fileira/cadeira estimada; postos/assentos mapeados por câmera (arrasta um retângulo, dá nome); e, opcionalmente,
  reconhecimento facial com consentimento (LGPD art. 11) — cadastro pela própria câmera, assinatura numérica só no navegador,
  apagar imediato.
- **Relatório**: taxa e nota, curva com pontos de queda, mapa de calor por fileira/cadeira, presença (entradas, saídas, pico),
  ruído, CSV pro Excel, impressão/PDF e histórico de sessões no navegador. Modo telão pra projetar só os números.

## Rodar na sua máquina

É um site estático (`web/`): qualquer servidor de arquivos serve. A câmera exige HTTPS ou `localhost`.

```bash
git clone https://github.com/ericluciano/radar-plateia
cd radar-plateia/web
python -m http.server 8790     # ou: npx serve .
# abra http://localhost:8790
```

Os modelos de visão já vêm embarcados em `web/vendor/` (funciona offline). Licenças dos componentes: `web/vendor/LICENSES.md`.

## Testes

```bash
cd web && npm test                 # motor (funções puras), Node 20+
python tests/e2e/run_all.py        # ponta a ponta com câmera falsa: Python 3.12 + playwright + ffmpeg
```

Os testes ponta a ponta geram vídeos a partir de um retrato: aponte `RADAR_FACE_IMG` pra uma foto de uma pessoa de frente
(ou salve em `web/tests/e2e/fixtures/rosto.png`). Detalhes em `web/tests/e2e/README.md`.

## Versão desktop (legado)

`radar_plateia.py` é a primeira versão (Python + MediaPipe + OpenCV), que avisa por voz no Windows. Continua no repositório,
mas a versão que evolui é a web. Rodar: `RADAR.bat` (cria o ambiente virtual na primeira vez) — precisa de Python 3.12.

## Privacidade

Nada sai da máquina: sem servidor, sem upload, sem gravação. O relatório guarda números e textos de aviso. O reconhecimento
facial é desligado por padrão, exige consentimento explícito e guarda só uma assinatura numérica do rosto, sem foto.

## Roteiro e decisões

`docs/ROADMAP.md` (o que foi entregue, o que vem, e por quê). Notas técnicas e gotchas: `CLAUDE.md`.

## Licença

MIT — feito por Eric Luciano na Expert Integrado (Mentoria Automações Inteligentes).
