# Testes de ponta a ponta (Playwright + Python)

Rodam o app num servidor local e num Chromium controlado, com câmera FALSA (vídeo gerado de uma foto com rosto)
ou com as webcams REAIS da máquina. Lêem o estado interno pelo hook `window.__radar.estado`.

Pré-requisitos: Python 3.12 com `playwright` (`pip install playwright && playwright install chromium`) e `ffmpeg` no PATH.

1. `python gerar_videos.py` — gera `C:/tmp/radar-fake-near.y4m` (rosto grande) e `C:/tmp/radar-fake.y4m` (rosto pequeno no canto,
   simula fundo de sala). A foto vem de `RADAR_FACE_IMG` (variável de ambiente) ou do caminho padrão dentro do script.
   Os `.y4m` têm ~55MB cada e NÃO entram no git.
2. `python test_web.py [URL]` — 1 câmera: motor inicia, rosto detectado, 5 modos trocam sem erro. Sem URL usa servidor local; com URL testa produção.
3. `python test_multicam_fake.py [URL]` — 2 células na mesma câmera falsa: soma dos contadores, grade 2, renomear, remover.
4. `python test_multicam_real.py` — Chrome VISÍVEL com as webcams reais (precisa de 2 câmeras plugadas). Tira screenshot em `saida/`.
5. `python run_all.py` — roda 1 a 3 em sequência (o teste real fica de fora, é manual).

Cada teste imprime `RESULTADO PASSOU|FALHOU` e sai com código 0/1.
