# Radar da Plateia — roteiro vivo

> Documento vivo: cada decisão do Eric ou entrega atualiza este arquivo no mesmo commit. Última revisão: 02/09/2026.

## O que é
App de navegador (radar.ericluciano.com.br) que analisa a câmera 100% na máquina de quem usa — nenhuma imagem sai do computador — e transforma isso em contadores, avisos (voz/apito/silencioso) e relatório. Nasceu ao vivo na Imersão 01/09/2026 pra saber quem estava sem olhar pra frente; virou base reaproveitável pra clientes (aula, evento, escritório, academia, linha de produção).

## Entregue
- v1 (01/09) app desktop Python com apito; v2 aviso por voz com fileira/cadeira; v3 app web publicado com 5 modos (Atenção, Exercício, Produtividade, Postura, Presença), aviso configurável, segundos por modo.
- v3.1 alcance Perto/Médio/Longe (varredura por zonas); v3.2 resolução real da câmera; v3.3 multi-câmera (células nomeadas, contadores somados, aviso com nome da câmera, rodízio de processamento, filtro de rosto suspeito).
- v3.4: motor separado (`engine.js`) com testes unitários, testes e2e no repositório, relatório de sessão com nota e exportação CSV, medidor de ruído da sala.
- v3.5 (02/09, este ciclo): **modo Segurança (EPI)** — detector de pessoas (corpo) embarcado, leitura de colete alta-visibilidade e capacete por cor, EPI obrigatório configurável (colete/capacete) e rigor, aviso "posição X sem colete há mais de N segundos", contadores com/sem EPI, conformidade por pessoa e no relatório. Absorveu e encerrou o app separado Monitor de EPI. Correção de bug: o primeiro aviso ficava mudo nos 20 s iniciais da página (valia pra todos os modos).

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

## Decisões tomadas pelo Eric (02/09/2026)
1. **Identificar quem é quem — OS DOIS.** Primeiro por **posto/assento** (cliente mapeia "posto 3 = João"; sem biometria). Depois **reconhecimento facial com foto cadastrada** onde o cliente assinar consentimento (biometria = dado sensível, LGPD art. 11) — embeddings faciais comparados localmente no navegador, foto nunca sai da máquina do cliente.
2. **EPI vira modo "Segurança" DENTRO do Radar.** O app separado "Monitor de EPI" (epi.ericluciano.com.br) não está em uso e foi encerrado; tudo se mescla aqui. Detecção de capacete/colete/óculos/luva por pessoa (modelo YOLO de EPI rodando no navegador, mesmo padrão dos outros modos) com aviso e relatório.
3. **Áudio: alerta por som, sem palavra de ativação.** Palavras de ativação saem do roteiro (Eric: "se eu estiver viajando, tira fora"). Fica: **grito/pico de ruído dispara alerta** (já dá com o medidor atual). Gravar o áudio do ambiente (para funcionário em serviço, com LGPD): NÃO contínuo — no máximo trecho curto em volta de um evento, opt-in, com aviso na tela; entra só quando um cliente pedir.
4. **Versão servidor: não agora.** Tudo local (navegador). Reabre quando um cliente confirmar câmeras IP.
5. **Repositório público no padrão da casa:** GitHub público "para os alunos" (instala quem precisar), com instruções de instalação, após varredura de dados pessoais (skill repo-vitrine). Licença **MIT** (o único precedente explícito nos nossos repos é o clickup-mcp, MIT).

## Próximas entregas (ordem sugerida, sem nova decisão)
1. ~~Modo Segurança (EPI) v1~~ — entregue na v3.5 (leitura por cor).
2. Identificação por posto/assento — mapa por câmera (arrastar caixas de posto sobre a imagem), nome nos avisos e no relatório de produtividade e de EPI.
3. Alerta por grito/pico de ruído + heatmap por fileira + curva com pontos de queda.
4. Reconhecimento facial com consentimento (cadastro de foto local, embeddings, LGPD por cliente).
5. Publicar o repositório (repo-vitrine + MIT).
6. Modo Segurança v2 — modelo TREINADO de EPI (capacete, colete, luva, óculos por detecção, não por cor), quando a leitura por cor não bastar num cliente real. Caminho compatível com o repo MIT: dataset público CC-BY (ex.: Construction Site Safety, Roboflow/Kaggle) + MediaPipe Model Maker (Apache 2.0) gerando `.tflite` pro mesmo `ObjectDetector` já embarcado. Pesos YOLO prontos (Ultralytics, keremberke) são AGPL e não entram. Exige conta no Roboflow ou Kaggle pra baixar o dataset (decisão/ação do Eric na hora) e algumas horas de GPU.

## Limites conhecidos
- Modelo de rosto embarcado é de curto alcance; o alcance Longe compensa por zonas mas depende de resolução e ângulo da câmera (a etiqueta CÂMERA mostra a resolução real).
- Roda numa aba do navegador: fechou a aba, parou. Sessões longas (turno de fábrica) pedem a versão servidor.
- Fileira/cadeira (e "posição N da esquerda" no modo Segurança) é estimativa geométrica.
- Câmera IP não entra no navegador (só USB/UVC, placa de captura, câmera virtual).
- Modo Segurança lê EPI por COR: colete de alta visibilidade é confiável; capacete é aproximado (cor forte ou branco no topo da cabeça) e por isso vem desligado por padrão. Luva e óculos não são detectáveis por cor — ficam pra v2 com modelo treinado.
