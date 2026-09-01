# Radar da Plateia — v1 (01/09/2026)
# Filma a plateia pela webcam e APITA quando alguem fica de cabeca baixa
# (celular/teclado) por tempo sustentado ou some da camera (olhou pra baixo de vez).
# 100% local: NAO grava video, NAO identifica ninguem, NAO envia nada pra fora.

import os
import sys
import time
import math
import argparse
import threading
import statistics
from datetime import datetime

os.environ.setdefault("GLOG_minloglevel", "2")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import cv2

try:
    import winsound
except ImportError:
    winsound = None

import mediapipe as mp

FD = mp.solutions.face_detection
KP = FD.FaceKeyPoint

LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", "eventos.log")

DEFAULTS = dict(
    width=1280,
    height=720,
    conf=0.35,           # confianca minima do detector
    tiles=True,          # varre tambem 4 quadrantes (pega rosto pequeno no fundo)
    look_down_s=6.0,     # segundos de cabeca baixa pra virar "disperso"
    recover_s=2.0,       # segundos de cabeca erguida pra voltar a "atento"
    baseline_s=3.0,      # janela de calibracao por rosto
    ratio_factor=0.62,   # abaixo de baseline*fator = cabeca baixa
    min_face_px=22,      # rosto menor que isso nao da geometria confiavel
    ghost_min_stable=5.0,  # so vira "sumiu" quem ficou estavel esse tempo antes
    ghost_ttl=5.0,       # quanto tempo o "sumiu" permanece contando
    ghost_delay=2.0,     # sumiu ha pelo menos isso pra contar como disperso
    beep_cooldown=12.0,  # intervalo minimo entre apitos
    min_dispersos=1,     # apita a partir de N dispersos
)


# ---------------------------------------------------------------- som

def beep_async():
    if winsound is None:
        return
    def run():
        try:
            winsound.Beep(880, 130)
            time.sleep(0.05)
            winsound.Beep(1175, 160)
        except RuntimeError:
            pass
    threading.Thread(target=run, daemon=True).start()


def log_evento(texto):
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {texto}\n")
    except OSError:
        pass


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


def pitch_ratio(kps):
    """Proxy de inclinacao da cabeca: distancia vertical nariz-olhos
    normalizada pela distancia entre os olhos. Cabeca baixa => valor cai."""
    re, le, no = kps.get(0), kps.get(1), kps.get(2)
    if not (re and le and no):
        return None
    inter = math.dist(re, le)
    if inter < 5:
        return None
    mid_y = (re[1] + le[1]) / 2.0
    return (no[1] - mid_y) / inter


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
        self.baseline = None
        self.down_since = None
        self.up_since = now
        self.gone = 0.0
        self.ghost = False
        self.distracted = False

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
        r = pitch_ratio(best["kps"])
        if r is not None and best["box"][2] >= cfg["min_face_px"]:
            if tr.baseline is None:
                tr.samples.append(r)
                if now - tr.first >= cfg["baseline_s"] and len(tr.samples) >= 5:
                    tr.baseline = statistics.median(tr.samples)
            elif r < tr.baseline * cfg["ratio_factor"]:
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
        down = tr.down_since is not None and (now - tr.down_since) >= cfg["look_down_s"]
        sumiu = tr.ghost and tr.gone >= cfg["ghost_delay"]
        tr.distracted = down or sumiu
        alive.append(tr)
    return alive


# ---------------------------------------------------------------- selftest

def selftest(n, cfg, cam):
    cap, idx = open_camera(cam, cfg["width"], cfg["height"])
    if cap is None:
        print("SELFTEST_FAIL camera=nenhuma")
        return 1
    det = Detector(cfg["conf"], tiles=True)
    t0 = time.monotonic()
    frames = ok_frames = faces_max = 0
    faces_frames = 0
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
    print(f"SELFTEST_OK cam={idx} res={res} frames_ok={ok_frames}/{n} "
          f"faces_max={faces_max} frames_com_face={faces_frames} fps={frames/dt:.1f}")
    cap.release()
    beep_async()
    time.sleep(0.6)
    print("BEEP_OK" if winsound else "BEEP_INDISPONIVEL")
    return 0


# ---------------------------------------------------------------- app

def main():
    ap = argparse.ArgumentParser(description="Radar da Plateia — apita quando alguem dispersa")
    ap.add_argument("--cam", type=int, default=None, help="indice da camera (padrao: primeira que responder)")
    ap.add_argument("--selftest", type=int, nargs="?", const=100, default=None, metavar="N",
                    help="testa camera+deteccao+som por N quadros e sai")
    ap.add_argument("--no-tiles", action="store_true", help="desliga varredura por quadrantes (mais rapido)")
    ap.add_argument("--conf", type=float, default=DEFAULTS["conf"])
    ap.add_argument("--width", type=int, default=DEFAULTS["width"])
    ap.add_argument("--height", type=int, default=DEFAULTS["height"])
    ap.add_argument("--segundos", type=float, default=DEFAULTS["look_down_s"],
                    help="segundos de cabeca baixa pra contar como disperso")
    ap.add_argument("--minimo", type=int, default=DEFAULTS["min_dispersos"],
                    help="apita a partir de N dispersos")
    args = ap.parse_args()

    cfg = dict(DEFAULTS)
    cfg["conf"] = args.conf
    cfg["width"], cfg["height"] = args.width, args.height
    cfg["look_down_s"] = args.segundos
    cfg["min_dispersos"] = max(1, args.minimo)
    cfg["tiles"] = not args.no_tiles

    if args.selftest is not None:
        sys.exit(selftest(args.selftest, cfg, args.cam))

    cap, idx = open_camera(args.cam, cfg["width"], cfg["height"])
    if cap is None:
        print("ERRO: nenhuma camera respondeu. Conecte/ligue a webcam e rode de novo.")
        sys.exit(1)
    print(f"Camera {idx} aberta. [q] sair  [m] mudo  [+/-] tolerancia  [1-9] minimo de dispersos  [p] pausa")
    log_evento(f"inicio camera={idx}")

    det = Detector(cfg["conf"], tiles=cfg["tiles"])
    tracks = []
    muted = False
    paused = False
    last_beep = 0.0
    beep_flash = 0.0
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
            fps = 0.9 * fps + 0.1 * (1.0 / max(dt, 1e-6)) if fps else 1.0 / max(dt, 1e-6)

            for tr in tracks:
                x, y, w, h = [int(v) for v in tr.box]
                if tr.distracted:
                    dispersos += 1
                    color = (0, 140, 255) if tr.ghost else (0, 0, 255)
                    label = "SUMIU" if tr.ghost else "DISPERSO"
                else:
                    atentos += 1
                    if tr.down_since is not None:
                        color, label = (0, 215, 255), "baixando..."
                    elif tr.baseline is None:
                        color, label = (200, 200, 200), ""
                    else:
                        color, label = (0, 200, 0), ""
                cv2.rectangle(frame, (x, y), (x + w, y + h), color, 2)
                if label:
                    cv2.putText(frame, label, (x, max(14, y - 6)),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

            if (dispersos >= cfg["min_dispersos"] and not muted
                    and now - last_beep >= cfg["beep_cooldown"]):
                beep_async()
                last_beep = now
                beep_flash = now
                log_evento(f"apito dispersos={dispersos} atentos={atentos}")

        hud = (f"ATENTOS {atentos}   DISPERSOS {dispersos}   |   apita com {cfg['min_dispersos']}+   "
               f"cabeca baixa {cfg['look_down_s']:.0f}s   {fps:.0f} fps"
               f"{'   [MUDO]' if muted else ''}{'   [PAUSADO]' if paused else ''}")
        cv2.rectangle(frame, (0, 0), (W, 34), (30, 30, 30), -1)
        cv2.putText(frame, hud, (10, 23), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                    (255, 255, 255), 1, cv2.LINE_AA)
        if now - beep_flash < 1.2:
            cv2.rectangle(frame, (0, 0), (W - 1, H - 1), (0, 0, 255), 10)

        cv2.imshow(win, frame)
        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), 27):
            break
        elif key == ord("m"):
            muted = not muted
        elif key == ord("p"):
            paused = not paused
            if paused:
                tracks = []
        elif key in (ord("+"), ord("=")):
            cfg["look_down_s"] = min(30.0, cfg["look_down_s"] + 1.0)
        elif key == ord("-"):
            cfg["look_down_s"] = max(2.0, cfg["look_down_s"] - 1.0)
        elif ord("1") <= key <= ord("9"):
            cfg["min_dispersos"] = key - ord("0")

    log_evento("fim")
    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
