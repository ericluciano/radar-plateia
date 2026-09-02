# Roda os testes e2e automatizaveis em sequencia (o teste com webcam real e manual).
import os, subprocess, sys
AQUI = os.path.dirname(os.path.abspath(__file__))
py = sys.executable
passos = ["gerar_videos.py", "test_web.py", "test_multicam_fake.py", "test_seguranca_fake.py"]
falhas = 0
for s in passos:
    print(f"\n=== {s} ===")
    r = subprocess.run([py, os.path.join(AQUI, s)] + sys.argv[1:], cwd=AQUI)
    falhas += 1 if r.returncode else 0
print("\nTOTAL_FALHAS", falhas)
sys.exit(1 if falhas else 0)
