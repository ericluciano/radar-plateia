# Testes de ponta a ponta (Playwright + Python)

Rodam o app num servidor local e num Chromium controlado, com câmera FALSA (vídeo gerado de uma foto com rosto)
ou com as webcams REAIS da máquina. Lêem o estado interno pelo hook `window.__radar.estado`.

Pré-requisitos: Python 3.12 com `playwright` (`pip install playwright && playwright install chromium`) e `ffmpeg` no PATH.

1. `python gerar_videos.py` — gera em `C:/tmp`: `radar-fake-near.y4m` (rosto grande), `radar-fake.y4m` (rosto pequeno no canto,
   simula fundo de sala), `radar-fake-pessoa.y4m` (pessoa inteira, sem colete) e `radar-fake-colete.y4m` (mesma pessoa com colete
   de alta visibilidade pintado no torso via PIL). A foto vem de `RADAR_FACE_IMG` (variável de ambiente) ou do caminho padrão dentro do script.
   Os `.y4m` têm ~55MB cada e NÃO entram no git.
2. `python test_web.py [URL]` — 1 câmera: motor inicia, rosto detectado, 5 modos trocam sem erro. Sem URL usa servidor local; com URL testa produção.
3. `python test_multicam_fake.py [URL]` — 2 células na mesma câmera falsa: soma dos contadores, grade 2, renomear, remover.
4. `python test_seguranca_fake.py [URL]` — modo Segurança: pessoa sem colete vira "Sem EPI" e gera aviso após T; pessoa com colete fica "Com EPI".
4b. `python test_postos_fake.py [URL]` — postos/assentos: posto mapeado sobre a pessoa vira o nome dela no aviso e nas estatísticas; persiste no navegador.
4c. `python test_facial_fake.py [URL]` — reconhecimento facial: sem consentimento não liga; cadastra o rosto da câmera falsa como "Eric Teste"; o nome aparece no track e no aviso; apagar limpa. Demora (carrega 8 MB de modelo e roda na CPU no headless).
4d. `python test_historico_fake.py [URL]` — histórico (IndexedDB) sobrevive ao recarregar e reabre no painel; presença (entradas/saídas/pico); modo telão; relatório imprimível montado.
5. `python test_multicam_real.py` — Chrome VISÍVEL com as webcams reais (precisa de 2 câmeras plugadas). Tira screenshot em `saida/`.
6. `python test_seguranca_real.py` — modo Segurança headless na webcam real (`RADAR_CAM_LABEL=BRIO` escolhe a câmera). Só prova que o
   detector de pessoas roda no hardware; o veredito de EPI depende de quem está na frente da câmera.
7. `python run_all.py` — roda 1 a 4 em sequência (os testes com câmera real ficam de fora).

Cada teste imprime `RESULTADO PASSOU|FALHOU` e sai com código 0/1.
