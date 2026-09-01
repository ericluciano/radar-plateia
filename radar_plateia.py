# Radar da Plateia — v2 (01/09/2026)
# Filma a plateia pela webcam e AVISA POR VOZ (sem apito) quando alguem fica
# 10s+ sem olhar pra frente: cabeca baixa (celular/teclado), virado pro lado
# ou rosto que some da camera. O aviso fala a posicao: "fileira X, cadeira Y".
# 100% local: NAO grava video, NAO identifica ninguem, NAO envia nada pra fora.

import os
import sys
import time
import math
import queue
import argparse
import threading
import subprocess
import statistics
from datetime import datetime

os.environ.setdefault("GLOG_minloglevel", "2")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import cv2
import mediapipe as mp

FD = mp.solutions.face_detection
KP = FD.FaceKeyPoint

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(BASE_DIR, "logs", "eventos.log")
FALAR_PS1 = os.path.join(BASE_DIR, "falar.ps1")
CREATE_NO_WINDOW = 0x08000000

DEFAULTS = dict(
    width=1280,
    height=720,
    conf=0.35,           # confianca minima do detector
    tiles=True,          # varre tambem 4 quadrantes (pega rosto pequeno no fundo)
    olhar_s=10.0,        # segundos sem olhar pra frente pra disparar o aviso
    recover_s=2.0,       # segundos olhando pra frente pra voltar a "atento"
    baseline_s=3.0,      # janela de calibracao por rosto
    yaw_dev=0.42,        # desvio lateral do nariz (x interocular) alem do baseline
    min_face_px=22,      # rosto menor que isso nao da geometria confiavel
    ghost_min_stable=5.0,  # so vira "sumiu" quem ficou estavel esse tempo antes
    ghost_ttl=16.0,      # quanto tempo o "sumiu" permanece sendo acompanhado
    audio_gap_s=20.0,    # intervalo minimo entre avisos falados
)


# ---------------------------------------------------------------- log

def log_evento(texto):
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {texto}\n")
    except OSError:
        pass


# ---------------------------------------------------------------- voz

class Speaker:
    """Fala frases em serie, com intervalo minimo entre elas, sem travar o video."""

    def __init__(self, gap_s):
        self.gap = gap_s
        self.q = queue.Queue(maxsize=3)
        self.muted = False
        self.last = 0.0
        threading.Thread(target=self._worker, daemon=True).start()

    def dizer(self, frase, marca_gap=True):
        try:
            self.q.put_nowait((frase, marca_gap))
        except queue.Full:
            log_evento(f"voz descartada (fila cheia): {frase}")

    def _falar_agora(self, frase):
        os.makedirs("C:/tmp", exist_ok=True)
        txt = f"C:/tmp/radar-frase-{int(time.time() * 1000)}.txt"
        with open(txt, "w", encoding="utf-8") as f:
            f.write(frase)
        try:
            subprocess.run(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                 "-File", FALAR_PS1, "-Arquivo", txt],
                creationflags=CREATE_NO_WINDOW, timeout=90,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        finally:
            try:
                os.remove(txt)
            except OSError:
                pass

    def _worker(self):
        while True:
            frase, marca_gap = self.q.get()
            espera = self.gap - (time.monotonic() - self.last)
            if marca_gap and espera > 0:
                time.sleep(espera)
            if self.muted:
                continue
            try:
                self._falar_agora(frase)
            except Exception as e:  # voz nunca derruba o radar
                log_evento(f"voz falhou: {e}")
            if marca_gap:
                self.last = time.monotonic()


# ---------------------------------------------------------------- camera

def open_camera(pref_idx, width, height):
    indices = [pref_idx] if pref_idx is not None else list(range(6))
    for idx in indices:
        cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW)
        if not cap.isOpened():
            cap.release()
            continue
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        ok = False
        for _ in range(12):
            ok, frame = cap.read()
            if ok and frame is not None:
                break
            time.sleep(0.05)
        if ok:
            return cap, idx
        cap.release()
    return None, None


# ---------------------------------------------------------------- deteccao

def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1 = max(ax, bx), max(ay, by)
    x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    if x2 <= x1 or y2 <= y1:
        return 0.0
    inter = (x2 - x1) * (y2 - y1)
    return inter / (aw * ah + bw * bh - inter)


def dedupe(dets):
    dets = sorted(dets, key=lambda d: -d["score"])
    keep = []
    for d in dets:
        if all(iou(d["box"], k["box"]) < 0.35 for k in keep):
            keep.append(d)
    return keep


class Detector:
    def __init__(self, conf, tiles=True):
        self.fd = FD.FaceDetection(model_selection=1, min_detection_confidence=conf)
        self.tiles = tiles

    def _region(self, rgb, ox, oy, out):
        res = self.fd.process(rgb)
        if not res.detections:
            return
        h, w = rgb.shape[:2]
        for det in res.detections:
            bb = det.location_data.relative_bounding_box
            box = (bb.xmin * w + ox, bb.ymin * h + oy, bb.width * w, bb.height * h)
            kps = {}
            for kp_id in (KP.RIGHT_EYE, KP.LEFT_EYE, KP.NOSE_TIP, KP.MOUTH_CENTER):
                p = FD.get_key_point(det, kp_id)
                if p:
                    kps[int(kp_id)] = (p.x * w + ox, p.y * h + oy)
            score = det.score[0] if det.score else 0.0
            out.append(dict(box=box, kps=kps, score=score))

    def detect(self, frame_bgr):
        H, W = frame_bgr.shape[:2]
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        out = []
        self._region(rgb, 0, 0, out)
        if self.tiles:
            tw, th = int(W * 0.56), int(H * 0.56)
            for ox in (0, W - tw):
                for oy in (0, H - th):
                    tile = np.ascontiguousarray(rgb[oy:oy + th, ox:ox + tw])
                    self._region(tile, ox, oy, out)
        return dedupe(out)


def face_geometry(kps):
    """(pitch, yaw) normalizados pela distancia entre olhos.
    pitch cai quando a cabeca baixa; yaw desloca quando vira pro lado."""
    re, le, no = kps.get(0), kps.get(1), kps.get(2)
    if not (re and le and no):
        return None
    inter = math.dist(re, le)
    if inter < 5:
        return None
    mid_x = (re[0] + le[0]) / 2.0
    mid_y = (re[1] + le[1]) / 2.0
    return (no[1] - mid_y) / inter, (no[0] - mid_x) / inter


# ---------------------------------------------------------------- tracking

class Track:
    _next = 1

    def __init__(self, det, now):
        self.id = Track._next
        Track._next += 1
        self.box = det["box"]
        self.kps = det["kps"]
        self.first = now
        self.last = now
        self.samples = []
        self.bp = None            # baseline de pitch (olhando pra frente)
        self.by = None            # baseline de yaw
        self.down_since = None
        self.up_since = now
        self.gone = 0.0
        self.ghost = False
        self.distracted = False
        self.alerted = False
        self.last_reason = "cabe\u00e7a baixa"

    def center(self):
        x, y, w, h = self.box
        return (x + w / 2.0, y + h / 2.0)


def update_tracks(tracks, dets, now, cfg, W, H):
    unmatched = list(dets)
    for tr in tracks:
        best, bd = None, 1e9
        cx, cy = tr.center()
        thr = max(70.0, tr.box[2] * 1.3)
        for d in unmatched:
            x, y, w, h = d["box"]
            dist = math.hypot(x + w / 2 - cx, y + h / 2 - cy)
            if dist < bd and dist < thr:
                bd, best = dist, d
        if best is None:
            continue
        unmatched.remove(best)
        tr.box, tr.kps, tr.last, tr.ghost = best["box"], best["kps"], now, False
        geom = face_geometry(best["kps"])
        if geom is not None and best["box"][2] >= cfg["min_face_px"]:
            pitch, yaw = geom
            if tr.bp is None:
                tr.samples.append((pitch, yaw))
                if now - tr.first >= cfg["baseline_s"] and len(tr.samples) >= 5:
                    tr.bp = statistics.median(p for p, _ in tr.samples)
                    tr.by = statistics.median(y for _, y in tr.samples)
            else:
                baixa = pitch < tr.bp - max(0.15, 0.35 * abs(tr.bp))
                lado = abs(yaw - tr.by) > cfg["yaw_dev"]
                if baixa or lado:
                    tr.last_reason = "cabe\u00e7a baixa" if baixa else "olhando pro lado"
                    tr.up_since = None
                    if tr.down_since is None:
                        tr.down_since = now
                else:
                    if tr.up_since is None:
                        tr.up_since = now
                    if tr.down_since is not None and now - tr.up_since >= cfg["recover_s"]:
                        tr.down_since = None

    for d in unmatched:
        tracks.append(Track(d, now))

    alive = []
    for tr in tracks:
        tr.gone = now - tr.last
        if tr.gone > 0.7:
            cx, cy = tr.center()
            near_edge = cx < W * 0.06 or cx > W * 0.94 or cy < H * 0.06 or cy > H * 0.94
            stable = (tr.last - tr.first) >= cfg["ghost_min_stable"]
            if stable and not near_edge and tr.gone <= cfg["ghost_ttl"]:
                tr.ghost = True
            else:
                continue  # descarta: saiu de cena ou era ruido
        down = tr.down_since is not None and (now - tr.down_since) >= cfg["olhar_s"]
        sumiu = tr.ghost and tr.gone >= cfg["olhar_s"]
        tr.distracted = down or sumiu
        if not tr.distracted and not tr.ghost and tr.down_since is None:
            tr.alerted = False  # voltou a olhar: libera aviso de episodio futuro
        alive.append(tr)
    return alive


# ---------------------------------------------------------------- fileira/cadeira

def posicao_na_sala(alvo, tracks):
    """Estima (fileira, cadeira) pela posicao dos rostos no quadro.
    Fileira 1 = mais perto da camera (baixo do quadro). Cadeira conta da esquerda do Eric."""
    if not tracks:
        return None
    med_h = statistics.median(t.box[3] for t in tracks)
    linhas = []
    for t in sorted(tracks, key=lambda t: -(t.box[1] + t.box[3])):
        by = t.box[1] + t.box[3]
        if linhas and abs(linhas[-1]["y"] - by) <= med_h * 0.9:
            linhas[-1]["itens"].append(t)
            ys = [i.box[1] + i.box[3] for i in linhas[-1]["itens"]]
            linhas[-1]["y"] = sum(ys) / len(ys)
        else:
            linhas.append({"y": by, "itens": [t]})
    for fi, linha in enumerate(linhas, 1):
        ordenados = sorted(linha["itens"], key=lambda t: t.center()[0])
        for ci, t in enumerate(ordenados, 1):
            if t is alvo:
                return fi, ci
    return None


def frase_alerta(tr, tracks, cfg):
    motivo = "sumiu da c\u00e2mera" if tr.ghost else tr.last_reason
    pos = posicao_na_sala(tr, tracks)
    seg = int(cfg["olhar_s"])
    if pos:
        fi, ci = pos
        return (f"Fileira {fi}, cadeira {ci} contando da sua esquerda: "
                f"{motivo} h\u00e1 mais de {seg} segundos."), pos, motivo
    return f"Algu\u00e9m est\u00e1 com {motivo} h\u00e1 mais de {seg} segundos.", None, motivo


# ---------------------------------------------------------------- selftest

def checar_voz():
    try:
        r = subprocess.run(["python", "-m", "edge_tts", "--help"],
                           capture_output=True, timeout=30, creationflags=CREATE_NO_WINDOW)
        return "edge-tts" if r.returncode == 0 else "sapi"
    except Exception:
        return "sapi"


def selftest(n, cfg, cam):
    cap, idx = open_camera(cam, cfg["width"], cfg["height"])
    if cap is None:
        print("SELFTEST_FAIL camera=nenhuma")
        return 1
    det = Detector(cfg["conf"], tiles=True)
    t0 = time.monotonic()
    frames = ok_frames = faces_max = faces_frames = 0
    while frames < n:
        ok, frame = cap.read()
        frames += 1
        if not ok or frame is None:
            continue
        ok_frames += 1
        d = det.detect(frame)
        if d:
            faces_frames += 1
        faces_max = max(faces_max, len(d))
    dt = max(time.monotonic() - t0, 1e-6)
    res = f"{int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))}x{int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))}"
    cap.release()
    print(f"SELFTEST_OK cam={idx} res={res} frames_ok={ok_frames}/{n} "
          f"faces_max={faces_max} frames_com_face={faces_frames} fps={frames/dt:.1f} voz={checar_voz()}")
    return 0


# ---------------------------------------------------------------- app

def main():
    ap = argparse.ArgumentParser(description="Radar da Plateia v2 — aviso por voz, sem apito")
    ap.add_argument("--cam", type=int, default=None)
    ap.add_argument("--selftest", type=int, nargs="?", const=100, default=None, metavar="N")
    ap.add_argument("--test-voz", action="store_true", help="fala uma frase de teste e sai")
    ap.add_argument("--no-tiles", action="store_true")
    ap.add_argument("--conf", type=float, default=DEFAULTS["conf"])
    ap.add_argument("--width", type=int, default=DEFAULTS["width"])
    ap.add_argument("--height", type=int, default=DEFAULTS["height"])
    ap.add_argument("--segundos", type=float, default=DEFAULTS["olhar_s"],
                    help="segundos sem olhar pra frente pra disparar o aviso")
    ap.add_argument("--gap", type=float, default=DEFAULTS["audio_gap_s"],
                    help="intervalo minimo entre avisos falados")
    args = ap.parse_args()

    cfg = dict(DEFAULTS)
    cfg["conf"] = args.conf
    cfg["width"], cfg["height"] = args.width, args.height
    cfg["olhar_s"] = args.segundos
    cfg["audio_gap_s"] = args.gap
    cfg["tiles"] = not args.no_tiles

    if args.test_voz:
        sp = Speaker(0.1)
        sp._falar_agora("Teste de voz do radar da plateia. Fileira dois, cadeira tr\u00eas, "
                        "cabe\u00e7a baixa h\u00e1 mais de dez segundos.")
        print("TESTE_VOZ_OK")
        return

    if args.selftest is not None:
        sys.exit(selftest(args.selftest, cfg, args.cam))

    cap, idx = open_camera(args.cam, cfg["width"], cfg["height"])
    if cap is None:
        print("ERRO: nenhuma camera respondeu. Conecte/ligue a webcam e rode de novo.")
        sys.exit(1)
    print(f"Camera {idx} aberta. [q] sair  [m] mudo  [+/-] segundos da regra  [p] pausa")
    log_evento(f"inicio v2 camera={idx} regra={cfg['olhar_s']}s")

    speaker = Speaker(cfg["audio_gap_s"])
    speaker.dizer("Radar de voz ativo.", marca_gap=False)

    det = Detector(cfg["conf"], tiles=cfg["tiles"])
    tracks = []
    paused = False
    flash = 0.0
    fps = 0.0
    win = "Radar da Plateia"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(win, 1100, 620)

    while True:
        ok, frame = cap.read()
        if not ok or frame is None:
            time.sleep(0.05)
            continue
        now = time.monotonic()
        H, W = frame.shape[:2]

        atentos = dispersos = 0
        if not paused:
            t0 = time.monotonic()
            dets = det.detect(frame)
            tracks = update_tracks(tracks, dets, now, cfg, W, H)
            dt = time.monotonic() - t0
            inst = 1.0 / max(dt, 1e-6)
            fps = 0.9 * fps + 0.1 * inst if fps else inst

            for tr in tracks:
                x, y, w, h = [int(v) for v in tr.box]
                if tr.distracted:
                    dispersos += 1
                    if tr.ghost:
                        color, label = (0, 140, 255), f"SUMIU {tr.gone:.0f}s"
                    else:
                        curto = "BAIXA" if "baixa" in tr.last_reason else "LADO"
                        color, label = (0, 0, 255), f"{curto} {now - tr.down_since:.0f}s"
                else:
                    atentos += 1
                    if tr.ghost:
                        color, label = (0, 140, 255), f"sumiu {tr.gone:.0f}s"
                    elif tr.down_since is not None:
                        curto = "baixa" if "baixa" in tr.last_reason else "lado"
                        color, label = (0, 215, 255), f"{curto} {now - tr.down_since:.0f}s"
                    elif tr.bp is None:
                        color, label = (200, 200, 200), ""
                    else:
                        color, label = (0, 200, 0), ""
                cv2.rectangle(frame, (x, y), (x + w, y + h), color, 2)
                if label:
                    cv2.putText(frame, label, (x, max(14, y - 6)),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

            for tr in tracks:
                if tr.distracted and not tr.alerted:
                    frase, pos, motivo = frase_alerta(tr, tracks, cfg)
                    if not speaker.muted:
                        speaker.dizer(frase)
                    tr.alerted = True
                    flash = now
                    log_evento(f"alerta pos={pos} motivo={motivo} dispersos={dispersos} atentos={atentos}")

        hud = (f"ATENTOS {atentos}   DISPERSOS {dispersos}   |   regra: {cfg['olhar_s']:.0f}s sem olhar pra frente   "
               f"aviso por VOZ   {fps:.0f} fps"
               f"{'   [MUDO]' if speaker.muted else ''}{'   [PAUSADO]' if paused else ''}")
        cv2.rectangle(frame, (0, 0), (W, 34), (30, 30, 30), -1)
        cv2.putText(frame, hud, (10, 23), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                    (255, 255, 255), 1, cv2.LINE_AA)
        if now - flash < 1.2:
            cv2.rectangle(frame, (0, 0), (W - 1, H - 1), (0, 0, 255), 10)

        cv2.imshow(win, frame)
        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), 27):
            break
        if cv2.getWindowProperty(win, cv2.WND_PROP_VISIBLE) < 1:
            break
        if key == ord("m"):
            speaker.muted = not speaker.muted
        elif key == ord("p"):
            paused = not paused
            if paused:
                tracks = []
        elif key in (ord("+"), ord("=")):
            cfg["olhar_s"] = min(60.0, cfg["olhar_s"] + 1.0)
        elif key == ord("-"):
            cfg["olhar_s"] = max(3.0, cfg["olhar_s"] - 1.0)

    log_evento("fim")
    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
