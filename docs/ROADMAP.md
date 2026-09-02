# Radar da Plateia — roteiro vivo

> Documento vivo: cada decisão do Eric ou entrega atualiza este arquivo no mesmo commit. Última revisão: 02/09/2026.

## O que é
App de navegador (radar.ericluciano.com.br) que analisa a câmera 100% na máquina de quem usa — nenhuma imagem sai do computador — e transforma isso em contadores, avisos (voz/apito/silencioso) e relatório. Nasceu ao vivo na Imersão 01/09/2026 pra saber quem estava sem olhar pra frente; virou base reaproveitável pra clientes (aula, evento, escritório, academia, linha de produção).

## Entregue
- v1 (01/09) app desktop Python com apito; v2 aviso por voz com fileira/cadeira; v3 app web publicado com 5 modos (Atenção, Exercício, Produtividade, Postura, Presença), aviso configurável, segundos por modo.
- v3.1 alcance Perto/Médio/Longe (varredura por zonas); v3.2 resolução real da câmera; v3.3 multi-câmera (células nomeadas, contadores somados, aviso com nome da câmera, rodízio de processamento, filtro de rosto suspeito).
- v3.4 (este ciclo): motor separado (`engine.js`) com testes unitários, testes e2e no repositório, relatório de sessão com nota e exportação CSV, medidor de ruído da sala.

## O que o mercado oferece (pesquisa 02/09/2026)
- Aulas/eventos: nota de engajamento 0-100 em tempo real, curva de atenção com pontos de queda, presença automática, relatório por sessão e por aluno (semana), alertas inteligentes ("atenção caiu", "quem está em risco"). Sinal considerado mais defensável: cabeça/olhar (comportamento observável), não emoção. Fontes: [Forasoft](https://www.forasoft.com/blog/article/ai-video-analytics-online-learning), [XenonStack](https://www.xenonstack.com/blog/computer-vision-for-monitoring-classroom-engagement), [ClassEngage AI](https://vizenta.ai/classengage-ai).
- Indústria/serviços: detecção de EPI (capacete, colete, luva, óculos) por pessoa com modelos YOLO em câmeras comuns e processamento local; painéis por período; câmeras IP. Fontes: [Ultralytics](https://www.ultralytics.com/blog/computer-vision-workplace-safety-ppe), [viAct](https://www.viact.ai/ppedetection), [Visionify](https://visionify.ai/ppe-compliance).
- Multi-câmera de prédio: não se constrói NVR — Frigate (open source, RTSP, detecção local) é a base natural (nota Brain 2ab6nhavyolr).

## Próximos passos SEM decisão pendente (ordem sugerida)
1. Curva de atenção com pontos de queda marcados e "alerta inteligente" da sala (atenção média caiu abaixo de X% por Y segundos) — o dado já existe no relatório.
2. Mapa de calor por fileira/cadeira ao fim da sessão (onde a dispersão se concentra).
3. Relatório em PDF/HTML imprimível além do CSV; histórico de sessões no navegador (IndexedDB) pra reabrir depois.
4. Presença automática: contagem ao entrar/sair + hora do pico, exportável.
5. Sons de aviso alternativos e aviso por voz em outros idiomas (Web Speech já suporta).
6. Modo tela cheia "telão" só com contadores e nota (pra projetar sem mostrar a câmera).

## Decisões do Eric (bloqueiam implementação)
1. **Identificar quem é quem** (Baú, academia): (A) por **posto/assento** — o sistema sabe que "posto 3 = João" por um mapa que o cliente preenche; sem biometria, LGPD leve; funciona em linha de produção e sala de aula com lugar fixo. (B) **reconhecimento facial** com foto cadastrada — biometria = dado sensível (LGPD art. 11), exige consentimento explícito e política; tecnicamente viável no navegador (embeddings faciais, comparação local). Recomendação: começar por A; B só com contrato/consentimento do cliente.
2. **EPI**: já existe projeto próprio em andamento (card Brain "Monitor de EPI", epi.ericluciano.com.br). Integrar como modo do Radar ou manter separado? Recomendação: manter separado até o modelo de EPI estar validado; depois vira modo.
3. **Palavras de ativação** (voz): o microfone já mede ruído; reconhecer palavras exige Web Speech (Chrome, online) ou modelo local. Falta definir O QUE a palavra dispara (marcar momento no relatório? silenciar avisos? contar "perguntas"?).
4. **Versão servidor** (câmeras IP/CFTV, várias por prédio, funcionar sem aba aberta): arquitetura sobre Frigate + nossa camada de modos. Quando algum cliente (academia/Baú) confirmar câmeras IP.
5. **Repositório público** (open source): passa pelo gate de PII (skill repo-vitrine); definir licença.

## Limites conhecidos
- Modelo de rosto embarcado é de curto alcance; o alcance Longe compensa por zonas mas depende de resolução e ângulo da câmera (a etiqueta CÂMERA mostra a resolução real).
- Roda numa aba do navegador: fechou a aba, parou. Sessões longas (turno de fábrica) pedem a versão servidor.
- Fileira/cadeira é estimativa geométrica.
- Câmera IP não entra no navegador (só USB/UVC, placa de captura, câmera virtual).
