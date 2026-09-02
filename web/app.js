// Radar da Plateia — v3.3 web, multi-câmera. Tudo roda NO NAVEGADOR: nenhuma imagem sai da máquina.
import { FaceDetector, FilesetResolver } from "./vendor/tasks-vision/vision_bundle.mjs";

const BUILD = "RADAR_V3_BUILD_20260902D";

// ------------------------------------------------------------------ modos
const MODOS = {
  atencao: {
    nome: "Atenção", icone: "◉",
    desc: "Aula/palestra: marca quem fica sem olhar pra frente e avisa.",
    segundos: 10,
    contadores: [["ok", "Atentos"], ["alerta", "Dispersos"]],
    usaAlerta: true,
  },
  exercicio: {
    nome: "Exercício", icone: "⌨",
    desc: "Mão na massa: todo mundo deve estar no notebook. Marca quem não está.",
    segundos: 15,
    contadores: [["ok", "No notebook"], ["alerta", "Fora do exercício"]],
    usaAlerta: true,
  },
  produtividade: {
    nome: "Produtividade", icone: "▤",
    desc: "Escritório: acompanha % de foco de cada pessoa ao longo do tempo.",
    segundos: 30,
    contadores: [["ok", "Focados"], ["alerta", "Sem foco"], ["neutro", "Foco médio"]],
    usaAlerta: true,
  },
  postura: {
    nome: "Postura", icone: "⌛",
    desc: "Bem-estar: avisa quem está parado na mesma posição há tempo demais.",
    segundos: 300,
    contadores: [["ok", "Em movimento"], ["alerta", "Parados"]],
    usaAlerta: true,
  },
  presenca: {
    nome: "Presença", icone: "▦",
    desc: "Contagem de pessoas ao vivo: agora, pico e evolução da sala.",
    segundos: 10,
    contadores: [["neutro", "Agora"], ["ok", "Pico"], ["neutro", "Média"]],
    usaAlerta: false,
  },
};

const ENG = {
  conf: 0.28, minFacePx: 22, baselineS: 3, recoverS: 2,
  yawDev: 0.42, ghostStable: 5, ghostTtl: 16,
  pitchFrontalAbs: 0.35, // modo exercício: rosto de frente (absoluto)
  moveFrac: 0.14,        // modo postura: deslocamento mínimo (fração da largura do rosto)
};

// ------------------------------------------------------------------ estado global
const cfg = carregarCfg();
let modo = cfg.modo in MODOS ? cfg.modo : "atencao";
let rodando = false;
let detector = null;
let ultimoAviso = 0;
let custoTick = [];
let amostrasPresenca = [];
let picoPresenca = 0;
const cams = [];
const erros = [];

const $ = (id) => document.getElementById(id);
const feedWrap = $("feed-wrap");
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ------------------------------------------------------------------ config persistente
function carregarCfg() {
  const base = {
    modo: "atencao", aviso: "voz", gap: 20, volume: 70, espelho: false, alcance: "longe",
    segundos: {}, cams: [{ deviceId: null, nome: "Câmera 1" }],
  };
  try {
    const s = JSON.parse(localStorage.getItem("radar.cfg.v1") || "{}");
    const out = { ...base, ...s, segundos: { ...(s.segundos || {}) } };
    if (!Array.isArray(s.cams) || !s.cams.length) {
      out.cams = [{ deviceId: s.camera || null, nome: "Câmera 1" }];
    }
    return out;
  } catch { return base; }
}
function salvarCfg() {
  cfg.modo = modo;
  cfg.cams = cams.map(c => ({ deviceId: c.deviceId, nome: c.nome }));
  try { localStorage.setItem("radar.cfg.v1", JSON.stringify(cfg)); } catch { /* modo anônimo */ }
}
function segundosDoModo() { return cfg.segundos[modo] ?? MODOS[modo].segundos; }

// ------------------------------------------------------------------ som e voz
let audioCtx = null;
function garantirAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) { erros.push("audio: " + e.message); }
}
function apitar() {
  try {
    garantirAudio();
    const vol = (cfg.volume / 100) * 0.5;
    [[880, 0, 0.14], [1175, 0.19, 0.18]].forEach(([f, t0, dur]) => {
      const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
      osc.frequency.value = f; osc.type = "sine";
      g.gain.setValueAtTime(0, audioCtx.currentTime + t0);
      g.gain.linearRampToValueAtTime(vol, audioCtx.currentTime + t0 + 0.02);
      g.gain.linearRampToValueAtTime(0, audioCtx.currentTime + t0 + dur);
      osc.connect(g).connect(audioCtx.destination);
      osc.start(audioCtx.currentTime + t0); osc.stop(audioCtx.currentTime + t0 + dur + 0.05);
    });
  } catch (e) { erros.push("apito: " + e.message); }
}
let vozPt = null;
function acharVozPt() {
  const vs = speechSynthesis.getVoices();
  vozPt = vs.find(v => v.lang === "pt-BR" && /microsoft|google/i.test(v.name))
       || vs.find(v => v.lang === "pt-BR") || vs.find(v => v.lang.startsWith("pt")) || null;
}
if ("speechSynthesis" in window) {
  acharVozPt();
  speechSynthesis.onvoiceschanged = acharVozPt;
}
function falar(texto) {
  try {
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = "pt-BR"; u.rate = 1.05; u.volume = cfg.volume / 100;
    if (vozPt) u.voice = vozPt;
    speechSynthesis.speak(u);
  } catch (e) { erros.push("voz: " + e.message); apitar(); }
}
function emitirAviso(texto) {
  const agora = performance.now() / 1000;
  if (agora - ultimoAviso < cfg.gap) return false;
  ultimoAviso = agora;
  if (cfg.aviso === "apito") apitar();
  else if (cfg.aviso === "voz") falar(texto);
  feedWrap.classList.remove("alerta-flash"); void feedWrap.offsetWidth;
  feedWrap.classList.add("alerta-flash");
  registrarLog(texto);
  return true;
}
function registrarLog(texto) {
  const log = $("log");
  log.querySelector(".vazio")?.remove();
  const li = document.createElement("li");
  li.innerHTML = `<span class="hora">${new Date().toLocaleTimeString("pt-BR")}</span>`;
  li.appendChild(document.createTextNode(texto));
  log.prepend(li);
  while (log.children.length > 100) log.lastChild.remove();
}

// ------------------------------------------------------------------ detector (um só, compartilhado)
async function criarDetector() {
  const fileset = await FilesetResolver.forVisionTasks("vendor/tasks-vision/wasm");
  for (const delegate of ["GPU", "CPU"]) {
    try {
      return await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "vendor/models/blaze_face_short_range.tflite", delegate },
        runningMode: "IMAGE",
        minDetectionConfidence: ENG.conf,
      });
    } catch (e) { erros.push(`detector ${delegate}: ${e.message}`); }
  }
  throw new Error("não consegui iniciar o detector de rostos");
}
const tileCanvas = document.createElement("canvas");
const tileCtx = tileCanvas.getContext("2d", { willReadFrequently: true });

function detectarRegiao(cam, sx, sy, sw, sh, saida) {
  // o modelo reduz tudo pra 128px internamente: pré-reduzir a 512px não perde alcance e corta o custo de cópia
  const escala = Math.min(1, 512 / sw);
  const dw = Math.max(1, Math.round(sw * escala)), dh = Math.max(1, Math.round(sh * escala));
  tileCanvas.width = dw; tileCanvas.height = dh;
  tileCtx.drawImage(cam.video, sx, sy, sw, sh, 0, 0, dw, dh);
  const res = detector.detect(tileCanvas);
  for (const d of res.detections) {
    const bb = d.boundingBox;
    saida.push({
      box: [bb.originX / escala + sx, bb.originY / escala + sy, bb.width / escala, bb.height / escala],
      kps: (d.keypoints || []).map(k => [k.x * sw + sx, k.y * sh + sy]),
      score: d.categories?.[0]?.score ?? 0,
    });
  }
}
const SCORE_MIN = 0.38; // abaixo disso o rosto é "suspeito" (textura de parede etc.): desenha apagado, não conta nem avisa
const valido = (t) => (t.score ?? 0) >= SCORE_MIN;
function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}
function zonasDoAlcance(W, H) {
  const n = cfg.alcance === "longe" ? 3 : cfg.alcance === "medio" ? 2 : 0;
  if (!n) return [];
  const frac = n === 3 ? 0.40 : 0.56;
  const tw = Math.round(W * frac), th = Math.round(H * frac);
  const zonas = [];
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++)
    zonas.push([Math.round(ix * (W - tw) / (n - 1 || 1)), Math.round(iy * (H - th) / (n - 1 || 1)), tw, th]);
  return zonas;
}
function detectarTudo(cam) {
  const W = cam.video.videoWidth, H = cam.video.videoHeight;
  const saida = [];
  detectarRegiao(cam, 0, 0, W, H, saida);
  const zonas = zonasDoAlcance(W, H);
  if (zonas.length) {
    const porVolta = zonas.length <= 4 ? zonas.length : 3; // 3x3 em rodízio de 3 por volta
    for (let k = 0; k < porVolta; k++) {
      const [sx, sy, sw, sh] = zonas[cam.tileCursor % zonas.length];
      cam.tileCursor++;
      detectarRegiao(cam, sx, sy, sw, sh, saida);
    }
  }
  saida.sort((a, b) => b.score - a.score);
  const unicos = [];
  for (const d of saida) {
    const duplicado = unicos.some(u => {
      if (iou(d.box, u.box) >= 0.35) return true;
      const x1 = Math.max(d.box[0], u.box[0]), y1 = Math.max(d.box[1], u.box[1]);
      const x2 = Math.min(d.box[0] + d.box[2], u.box[0] + u.box[2]);
      const y2 = Math.min(d.box[1] + d.box[3], u.box[1] + u.box[3]);
      const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      return inter / (d.box[2] * d.box[3]) > 0.7;
    });
    if (!duplicado) unicos.push(d);
  }
  return unicos;
}
function geometria(kps) {
  if (kps.length < 3) return null;
  const [re, le, no] = kps;
  const inter = Math.hypot(re[0] - le[0], re[1] - le[1]);
  if (inter < 5) return null;
  return { pitch: (no[1] - (re[1] + le[1]) / 2) / inter, yaw: (no[0] - (re[0] + le[0]) / 2) / inter };
}
const mediana = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const formataDur = (s) => s >= 120 ? `${Math.round(s / 60)} minutos` : `${Math.round(s)} segundos`;

// ------------------------------------------------------------------ tracker (por câmera)
function atualizarTracks(cam, dets, agora) {
  const W = cam.video.videoWidth, H = cam.video.videoHeight;
  const livres = [...dets];
  for (const tr of cam.tracks) {
    let melhor = null, md = 1e9;
    const cx = tr.box[0] + tr.box[2] / 2, cy = tr.box[1] + tr.box[3] / 2;
    const limite = Math.max(70, tr.box[2] * 1.3);
    for (const d of livres) {
      const dist = Math.hypot(d.box[0] + d.box[2] / 2 - cx, d.box[1] + d.box[3] / 2 - cy);
      if (dist < md && dist < limite) { md = dist; melhor = d; }
    }
    if (!melhor) continue;
    livres.splice(livres.indexOf(melhor), 1);
    tr.box = melhor.box; tr.kps = melhor.kps; tr.visto = agora; tr.ghost = false;
    tr.score = 0.8 * tr.score + 0.2 * melhor.score;
    const g = geometria(melhor.kps);
    tr.geo = g;
    if (g && melhor.box[2] >= ENG.minFacePx) {
      if (tr.bp === null) {
        tr.amostras.push([g.pitch, g.yaw]);
        if (agora - tr.inicio >= ENG.baselineS && tr.amostras.length >= 5) {
          tr.bp = mediana(tr.amostras.map(a => a[0]));
          tr.by = mediana(tr.amostras.map(a => a[1]));
        }
      } else {
        const baixa = g.pitch < tr.bp - Math.max(0.15, 0.35 * Math.abs(tr.bp));
        const lado = Math.abs(g.yaw - tr.by) > ENG.yawDev;
        if (baixa || lado) {
          tr.motivo = baixa ? "cabeça baixa" : "olhando pro lado";
          tr.ergueuEm = null;
          if (tr.baixouEm === null) tr.baixouEm = agora;
        } else {
          if (tr.ergueuEm === null) tr.ergueuEm = agora;
          if (tr.baixouEm !== null && agora - tr.ergueuEm >= ENG.recoverS) tr.baixouEm = null;
        }
      }
    }
    const erguido = !g || g.pitch >= ENG.pitchFrontalAbs;
    if (erguido) { if (tr.frenteDesde === null) tr.frenteDesde = agora; }
    else tr.frenteDesde = null;
    if (!tr.ref) tr.ref = { cx, cy, w: tr.box[2], em: agora };
    const ncx = tr.box[0] + tr.box[2] / 2, ncy = tr.box[1] + tr.box[3] / 2;
    if (Math.hypot(ncx - tr.ref.cx, ncy - tr.ref.cy) > ENG.moveFrac * tr.box[2]
        || Math.abs(tr.box[2] - tr.ref.w) > 0.2 * tr.ref.w) {
      tr.ref = { cx: ncx, cy: ncy, w: tr.box[2], em: agora };
    }
  }
  for (const d of livres) {
    cam.tracks.push({
      id: cam.proximoId++, box: d.box, kps: d.kps, geo: null, score: d.score,
      inicio: agora, visto: agora, amostras: [], bp: null, by: null,
      baixouEm: null, ergueuEm: agora, motivo: "cabeça baixa",
      frenteDesde: agora, ref: null,
      ghost: false, sumido: 0, avisado: false,
      focoS: 0, totalS: 0, ultimoTick: agora,
    });
  }
  cam.tracks = cam.tracks.filter(tr => {
    tr.sumido = agora - tr.visto;
    if (tr.sumido > 1.6) {
      const cx = tr.box[0] + tr.box[2] / 2, cy = tr.box[1] + tr.box[3] / 2;
      const naBorda = cx < W * 0.06 || cx > W * 0.94 || cy < H * 0.06 || cy > H * 0.94;
      const estavel = tr.visto - tr.inicio >= ENG.ghostStable;
      if (!(estavel && valido(tr) && !naBorda && tr.sumido <= ENG.ghostTtl)) return false;
      tr.ghost = true;
      tr.frenteDesde = null;
    }
    return true;
  });
}

// ------------------------------------------------------------------ fileira e cadeira (por câmera)
function posicaoNaSala(cam, alvo) {
  const ts = cam.tracks;
  if (!ts.length) return null;
  const medH = mediana(ts.map(t => t.box[3]));
  const linhas = [];
  for (const t of [...ts].sort((a, b) => (b.box[1] + b.box[3]) - (a.box[1] + a.box[3]))) {
    const by = t.box[1] + t.box[3];
    const ult = linhas[linhas.length - 1];
    if (ult && Math.abs(ult.y - by) <= medH * 0.9) {
      ult.itens.push(t);
      ult.y = ult.itens.reduce((s, i) => s + i.box[1] + i.box[3], 0) / ult.itens.length;
    } else linhas.push({ y: by, itens: [t] });
  }
  for (let fi = 0; fi < linhas.length; fi++) {
    const ordem = [...linhas[fi].itens].sort((a, b) => (a.box[0] + a.box[2] / 2) - (b.box[0] + b.box[2] / 2));
    const ci = ordem.indexOf(alvo);
    if (ci >= 0) return [fi + 1, ci + 1];
  }
  return null;
}
function ondeFica(cam, tr) {
  const pos = posicaoNaSala(cam, tr);
  const lugar = pos ? `Fileira ${pos[0]}, cadeira ${pos[1]} contando da sua esquerda` : "Alguém";
  return cams.length > 1 ? `${cam.nome}: ${lugar}` : lugar;
}

// ------------------------------------------------------------------ regras por modo (por câmera)
function avaliar(cam, agora) {
  const T = segundosDoModo();
  const m = MODOS[modo];
  let bons = 0, ruins = 0;
  for (const tr of cam.tracks) {
    const dt = Math.min(agora - tr.ultimoTick, 1); tr.ultimoTick = agora;
    let flag = false, cand = 0, rotulo = "", motivo = "";
    if (!valido(tr)) { tr.estado = "suspeito"; tr.rotulo = ""; continue; }

    if (modo === "atencao" || modo === "produtividade") {
      const semOlhar = tr.ghost ? tr.sumido : (tr.baixouEm !== null ? agora - tr.baixouEm : 0);
      motivo = tr.ghost ? "sumiu da câmera" : tr.motivo;
      flag = semOlhar >= T; cand = semOlhar;
      rotulo = flag || cand > 1 ? `${tr.ghost ? "SUMIU" : motivo === "cabeça baixa" ? "BAIXA" : "LADO"} ${Math.floor(cand)}s` : "";
      tr.totalS += dt; if (cand === 0) tr.focoS += dt;
      if (flag && modo === "produtividade") motivo = `sem foco (${motivo})`;
    } else if (modo === "exercicio") {
      if (tr.ghost) { bons++; tr.estado = "ok"; tr.rotulo = ""; continue; }
      const fora = tr.frenteDesde !== null ? agora - tr.frenteDesde : 0;
      flag = fora >= T; cand = fora; motivo = "fora do exercício";
      rotulo = flag ? `FORA ${Math.floor(fora)}s` : (fora > 2 ? `de frente ${Math.floor(fora)}s` : "");
    } else if (modo === "postura") {
      if (tr.ghost) continue;
      const parado = agora - (tr.ref?.em ?? agora);
      flag = parado >= T; cand = parado; motivo = "parado na mesma posição";
      rotulo = parado >= 30 ? `PARADO ${formataDur(parado)}` : "";
    } else { // presença
      if (tr.ghost) continue;
      bons++; tr.estado = "neutro"; tr.rotulo = ""; continue;
    }

    tr.estado = flag ? "flag" : (cand > 1 && modo !== "postura" ? "warn" : "ok");
    tr.rotulo = rotulo;
    if (flag) ruins++; else bons++;

    if (flag && !tr.avisado && m.usaAlerta) {
      const tempoTxt = modo === "postura" ? `há mais de ${formataDur(T)}` : `há mais de ${Math.round(T)} segundos`;
      const frase = `${ondeFica(cam, tr)}: ${motivo} ${tempoTxt}.${modo === "postura" ? " Hora de alongar." : ""}`;
      if (emitirAviso(frase)) tr.avisado = true;
    }
    if (!flag && cand === 0) tr.avisado = false;
    if (modo === "postura" && !flag) tr.avisado = false;
  }
  return { bons, ruins };
}

// ------------------------------------------------------------------ desenho (por câmera)
const CORES = { ok: "#34e08c", warn: "#ffc23e", flag: "#ff4d5e", ghost: "#ff9a3e", neutro: "#3ee0ff", calib: "#8aa0b4" };
function desenhar(cam) {
  const W = cam.canvas.width = cam.video.videoWidth, H = cam.canvas.height = cam.video.videoHeight;
  const ctx = cam.ctx;
  ctx.clearRect(0, 0, W, H);
  ctx.font = `${Math.max(14, W / 70)}px "IBM Plex Mono", monospace`;
  ctx.lineWidth = Math.max(2, W / 500);
  for (const tr of cam.tracks) {
    if (tr.ghost && modo !== "atencao" && modo !== "produtividade") continue;
    const suspeito = !valido(tr);
    if (suspeito && tr.ghost) continue;
    const cor = suspeito ? CORES.calib : tr.ghost ? CORES.ghost
      : (tr.bp === null && (modo === "atencao" || modo === "produtividade")) ? CORES.calib
      : CORES[tr.estado || "neutro"] || CORES.neutro;
    const [x, y, w, h] = tr.box;
    ctx.strokeStyle = cor;
    ctx.setLineDash(suspeito ? [6, 6] : []);
    ctx.strokeRect(x, y, w, h);
    if (tr.rotulo && !suspeito) { ctx.fillStyle = cor; ctx.fillText(tr.rotulo, x, Math.max(16, y - 6)); }
  }
  ctx.setLineDash([]);
}

// ------------------------------------------------------------------ câmera (célula)
class Cam {
  constructor(spec) {
    this.deviceId = spec.deviceId || null;
    this.nome = spec.nome || `Câmera ${cams.length + 1}`;
    this.tracks = []; this.proximoId = 1; this.tileCursor = 0;
    this.rodando = false; this.stream = null; this.fps = 0; this.lastFaces = 0; this.res = ""; this.erro = null;
    this.bons = 0; this.ruins = 0;
    this.montar();
  }
  montar() {
    this.el = document.createElement("div");
    this.el.className = "cell";
    this.el.innerHTML = `
      <div class="cell-top">
        <input class="cell-nome" value="${esc(this.nome)}" title="Nome do ambiente (clique pra editar)">
        <select class="cell-dev" title="Qual câmera alimenta esta célula"><option value="">câmera padrão</option></select>
        <span class="cell-meta mono">—</span>
        <button class="cell-x" title="Remover câmera">×</button>
      </div>
      <div class="cell-video">
        <video playsinline muted></video><canvas></canvas>
        <div class="cell-msg" hidden></div>
      </div>`;
    this.video = this.el.querySelector("video");
    this.canvas = this.el.querySelector("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.meta = this.el.querySelector(".cell-meta");
    this.msg = this.el.querySelector(".cell-msg");
    this.sel = this.el.querySelector(".cell-dev");
    this.el.querySelector(".cell-nome").addEventListener("input", (e) => {
      this.nome = e.target.value.trim() || this.nome; salvarCfg();
    });
    this.sel.addEventListener("change", async () => {
      this.deviceId = this.sel.value || null; salvarCfg();
      if (this.rodando) { this.parar(); await this.ligar(); }
    });
    this.el.querySelector(".cell-x").addEventListener("click", () => removerCam(this));
    $("feeds").appendChild(this.el);
    atualizarGrade();
  }
  preencherDevices(devs) {
    const atual = this.deviceId || "";
    this.sel.innerHTML = `<option value="">câmera padrão</option>` + devs
      .map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || "Câmera " + (i + 1))}</option>`).join("");
    this.sel.value = devs.some(d => d.deviceId === atual) ? atual : "";
  }
  async ligar() {
    this.erro = null; this.msg.hidden = true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
                 width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      this.res = `${this.video.videoWidth}×${this.video.videoHeight}`;
      this.rodando = true; this.tracks = []; this.tileCursor = 0;
      this.meta.textContent = this.res;
      if (this.video.videoHeight < 700) registrarLog(`${this.nome}: câmera entregou só ${this.res} — resolução baixa limita o alcance da detecção`);
      return true;
    } catch (e) {
      this.erro = e.name === "NotReadableError" ? "câmera em uso por outro programa — feche-o e tente de novo"
        : e.name === "NotAllowedError" ? "permissão negada — libere a câmera no cadeado da barra do navegador"
        : e.name === "OverconstrainedError" || e.name === "NotFoundError" ? "essa câmera não foi encontrada — escolha outra na lista"
        : "não abriu: " + e.message;
      this.msg.textContent = this.erro; this.msg.hidden = false;
      this.meta.textContent = "erro";
      erros.push(`${this.nome}: ${e.name} ${e.message}`);
      return false;
    }
  }
  parar() {
    this.rodando = false;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null; this.video.srcObject = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.meta.textContent = "—";
  }
  tick(agora) {
    if (!this.rodando || this.video.readyState < 2 || !this.video.videoWidth) return { bons: 0, ruins: 0 };
    const t0 = performance.now();
    const dets = detectarTudo(this);
    this.lastFaces = dets.length;
    atualizarTracks(this, dets, agora);
    const r = avaliar(this, agora);
    desenhar(this);
    const inst = 1000 / Math.max(performance.now() - t0, 1);
    this.fps = this.fps ? 0.9 * this.fps + 0.1 * inst : inst;
    this.bons = r.bons; this.ruins = r.ruins;
    const [, rotOk] = MODOS[modo].contadores[0], [, rotRuim] = MODOS[modo].contadores[1];
    this.meta.textContent = modo === "presenca"
      ? `${this.res} · ${r.bons} pessoa${r.bons === 1 ? "" : "s"}`
      : `${this.res} · ${r.bons} ${rotOk.toLowerCase()} · ${r.ruins} ${rotRuim.toLowerCase()}`;
    return r;
  }
}
function atualizarGrade() { $("feeds").dataset.n = Math.min(cams.length, 4); }
function adicionarCam(spec = {}) {
  const cam = new Cam(spec);
  cams.push(cam);
  atualizarGrade();
  salvarCfg();
  listarCameras();
  if (rodando) cam.ligar();
  return cam;
}
function removerCam(cam) {
  cam.parar();
  cam.el.remove();
  cams.splice(cams.indexOf(cam), 1);
  if (!cams.length) adicionarCam({ nome: "Câmera 1" });
  atualizarGrade(); salvarCfg();
}
async function listarCameras() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
    cams.forEach(c => c.preencherDevices(devs));
  } catch { /* sem permissão ainda */ }
}

// ------------------------------------------------------------------ contadores e stats (agregados)
function renderContadores(bons, ruins) {
  const el = $("contadores");
  const m = MODOS[modo];
  let vals;
  if (modo === "presenca") {
    const agora = cams.reduce((s, c) => s + c.tracks.filter(t => !t.ghost && valido(t)).length, 0);
    picoPresenca = Math.max(picoPresenca, agora);
    const media = amostrasPresenca.length
      ? Math.round(amostrasPresenca.reduce((s, a) => s + a[1], 0) / amostrasPresenca.length) : agora;
    vals = [agora, picoPresenca, media];
  } else if (modo === "produtividade") {
    const pcts = cams.flatMap(c => c.tracks).filter(t => t.totalS > 10).map(t => t.focoS / t.totalS);
    const medio = pcts.length ? Math.round(100 * pcts.reduce((s, p) => s + p, 0) / pcts.length) : 100;
    vals = [bons, ruins, medio + "%"];
  } else vals = [bons, ruins];
  el.innerHTML = m.contadores.map(([cls, rot], i) =>
    `<div class="contador ${cls}"><div class="num">${vals[i] ?? 0}</div><div class="rot">${rot}</div></div>`).join("");
}
function renderStats() {
  const painel = $("painel-stats"), corpo = $("stats-corpo");
  if (modo === "produtividade") {
    painel.hidden = false; $("stats-titulo").textContent = "Foco por pessoa";
    const linhas = cams.flatMap(cam => cam.tracks.filter(t => t.totalS > 10).map(t => ({ cam, t, pct: t.focoS / t.totalS })))
      .sort((a, b) => a.pct - b.pct).slice(0, 14);
    corpo.innerHTML = linhas.length ? linhas.map(({ cam, t, pct }) => {
      const pos = posicaoNaSala(cam, t);
      const nome = (cams.length > 1 ? esc(cam.nome) + " " : "") + (pos ? `F${pos[0]}·C${pos[1]}` : `#${t.id}`);
      return `<div class="stat-linha ${pct < 0.6 ? "ruim" : ""}"><span>${nome}</span>
        <span class="barra"><i style="width:${Math.round(pct * 100)}%"></i></span>
        <span>${Math.round(pct * 100)}%</span></div>`;
    }).join("") : `<p style="color:var(--dim);font-size:12px">acumulando… aparece após 10s de cada pessoa</p>`;
  } else if (modo === "presenca") {
    painel.hidden = false; $("stats-titulo").textContent = cams.length > 1 ? "Evolução (todas as câmeras)" : "Evolução da sala";
    if (!$("spark")) corpo.innerHTML = `<canvas id="spark"></canvas>`;
    desenharSpark();
  } else painel.hidden = true;
}
function desenharSpark() {
  const c = $("spark"); if (!c) return;
  const w = c.width = c.clientWidth || 300, h = c.height = 64;
  const g = c.getContext("2d");
  g.clearRect(0, 0, w, h);
  if (amostrasPresenca.length < 2) return;
  const max = Math.max(picoPresenca, 1);
  g.beginPath();
  amostrasPresenca.forEach(([, n], i) => {
    const x = (i / (amostrasPresenca.length - 1)) * (w - 4) + 2;
    const y = h - 4 - (n / max) * (h - 10);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.strokeStyle = "#3ee0ff"; g.lineWidth = 2; g.stroke();
}

// ------------------------------------------------------------------ loop único
let camCursor = 0;
function loop() {
  if (!rodando) return;
  const t0 = performance.now();
  try {
    const agora = performance.now() / 1000;
    // uma câmera por volta (rodízio): o custo por volta fica o de 1 câmera, cada uma atualiza a cada N voltas
    const ativas = cams.filter(c => c.rodando);
    if (ativas.length) { ativas[camCursor % ativas.length].tick(agora); camCursor++; }
    const bons = ativas.reduce((s, c) => s + c.bons, 0), ruins = ativas.reduce((s, c) => s + c.ruins, 0);
    renderContadores(bons, ruins);
    renderStats();
    if (modo === "presenca" && (!amostrasPresenca.length || agora - amostrasPresenca[amostrasPresenca.length - 1][0] >= 2)) {
      amostrasPresenca.push([agora, cams.reduce((s, c) => s + c.tracks.filter(t => !t.ghost && valido(t)).length, 0)]);
      if (amostrasPresenca.length > 900) amostrasPresenca.shift();
    }
  } catch (e) { erros.push("loop: " + e.message); }
  const custo = performance.now() - t0;
  custoTick.push(custo); if (custoTick.length > 30) custoTick.shift();
  const medio = custoTick.reduce((s, c) => s + c, 0) / custoTick.length;
  if (custoTick.length === 30 && medio > 180 && cfg.alcance !== "perto") {
    cfg.alcance = cfg.alcance === "longe" ? "medio" : "perto";
    custoTick = [];
    registrarLog(`máquina lenta com ${cams.length} câmera(s): alcance reduzido pra ${cfg.alcance === "medio" ? "Médio" : "Perto"}`);
    aplicarUi();
  }
  $("pill-fps").textContent = `${(1000 / Math.max(custo, 1)).toFixed(0)} fps`;
  setTimeout(loop, Math.max(10, 90 - custo));
}

// ------------------------------------------------------------------ ligar / parar tudo
function setPill(id, estado) { $(id).querySelector(".dot").className = "dot " + estado; }
async function ligarTudo() {
  const btn = $("btn-ligar");
  btn.disabled = true; btn.textContent = "Ligando…";
  garantirAudio();
  try {
    if (!detector) { setPill("pill-motor", "carregando"); detector = await criarDetector(); setPill("pill-motor", "on"); }
    let ok = 0;
    for (const cam of cams) if (await cam.ligar()) ok++;
    await listarCameras();
    if (ok) {
      $("feed-vazio").hidden = true; $("btn-fs").hidden = false; $("btn-parar").hidden = false;
      setPill("pill-camera", "on");
      $("pill-camera").lastChild.textContent = ok > 1 ? `${ok} CÂMERAS` : `CÂMERA ${cams[0].res}`;
      rodando = true; custoTick = []; amostrasPresenca = []; picoPresenca = 0;
      loop();
      if (cfg.aviso === "voz") falar(`Radar ativo. Modo ${MODOS[modo].nome}${ok > 1 ? `, ${ok} câmeras` : ""}.`);
    } else {
      setPill("pill-camera", "erro");
      $("feed-msg").innerHTML = cams[0]?.erro || "Nenhuma câmera abriu.";
    }
  } catch (e) {
    setPill("pill-motor", "erro");
    $("feed-msg").textContent = "Falha ao iniciar o motor: " + e.message;
    erros.push("motor: " + e.message);
  }
  btn.disabled = false; btn.textContent = "Ligar câmeras";
}
function pararTudo() {
  rodando = false;
  cams.forEach(c => c.parar());
  $("feed-vazio").hidden = false;
  $("feed-msg").innerHTML = "Câmeras paradas. Clique em <strong>Ligar câmeras</strong> pra retomar.";
  $("btn-parar").hidden = true; $("btn-fs").hidden = true;
  setPill("pill-camera", "off");
  $("pill-camera").lastChild.textContent = "CÂMERA";
}

// ------------------------------------------------------------------ UI
function renderModos() {
  $("modos").innerHTML = Object.entries(MODOS).map(([k, m]) => `
    <button class="modo ${k === modo ? "ativo" : ""}" data-modo="${k}">
      <span class="icone">${m.icone}</span>
      <span class="nome">Modo ${m.nome}</span>
      <span class="desc">${m.desc}</span>
    </button>`).join("");
}
function aplicarUi() {
  renderModos();
  const T = segundosDoModo();
  $("inp-seg").value = T; $("lbl-seg").textContent = formataDur(T);
  $("inp-gap").value = cfg.gap; $("lbl-gap").textContent = cfg.gap + "s";
  $("inp-vol").value = cfg.volume; $("lbl-vol").textContent = cfg.volume + "%";
  $("chk-espelho").checked = cfg.espelho;
  $("feeds").classList.toggle("espelhado", cfg.espelho);
  document.querySelectorAll("#seg-aviso button").forEach(b => b.classList.toggle("ativo", b.dataset.v === cfg.aviso));
  document.querySelectorAll("#seg-alcance button").forEach(b => b.classList.toggle("ativo", b.dataset.v === cfg.alcance));
  renderContadores(0, 0); renderStats();
}
function reiniciarTracking() {
  cams.forEach(c => { c.tracks = []; c.tileCursor = 0; });
  amostrasPresenca = []; picoPresenca = 0; custoTick = [];
}

$("modos").addEventListener("click", (ev) => {
  const b = ev.target.closest(".modo"); if (!b) return;
  modo = b.dataset.modo; reiniciarTracking(); salvarCfg(); aplicarUi();
  registrarLog(`modo trocado: ${MODOS[modo].nome} (regra ${formataDur(segundosDoModo())})`);
});
$("inp-seg").addEventListener("input", () => {
  cfg.segundos[modo] = Number($("inp-seg").value);
  $("lbl-seg").textContent = formataDur(segundosDoModo()); salvarCfg();
});
$("seg-aviso").addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  cfg.aviso = b.dataset.v; salvarCfg(); aplicarUi();
  if (cfg.aviso === "apito") apitar();
  if (cfg.aviso === "voz") falar("Avisos por voz.");
});
$("seg-alcance").addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  cfg.alcance = b.dataset.v; cams.forEach(c => c.tileCursor = 0); custoTick = [];
  salvarCfg(); aplicarUi();
});
$("inp-gap").addEventListener("input", () => { cfg.gap = Number($("inp-gap").value); $("lbl-gap").textContent = cfg.gap + "s"; salvarCfg(); });
$("inp-vol").addEventListener("input", () => { cfg.volume = Number($("inp-vol").value); $("lbl-vol").textContent = cfg.volume + "%"; salvarCfg(); });
$("chk-espelho").addEventListener("change", () => { cfg.espelho = $("chk-espelho").checked; salvarCfg(); aplicarUi(); });
$("btn-ligar").addEventListener("click", ligarTudo);
$("btn-parar").addEventListener("click", pararTudo);
$("btn-add-cam").addEventListener("click", () => adicionarCam({ nome: `Câmera ${cams.length + 1}` }));
$("btn-fs").addEventListener("click", () => {
  document.fullscreenElement ? document.exitFullscreen() : feedWrap.requestFullscreen();
});
$("btn-limpar").addEventListener("click", () => { $("log").innerHTML = `<li class="vazio">nenhum aviso ainda</li>`; });

// debug / teste automatizado
window.__radar = {
  get estado() {
    return {
      build: BUILD, rodando, modo, engineOk: !!detector, erros: [...erros],
      cams: cams.map(c => ({ nome: c.nome, rodando: c.rodando, res: c.res, lastFaces: c.lastFaces,
                             tracks: c.tracks.length, validos: c.tracks.filter(valido).length,
                             bons: c.bons, ruins: c.ruins, fps: Number(c.fps.toFixed(1)), erro: c.erro,
                             videoT: Number(c.video.currentTime.toFixed(1)), videoRs: c.video.readyState,
                             trackState: c.stream?.getVideoTracks()[0]?.readyState ?? null })),
    };
  },
  devices: async () => (await navigator.mediaDevices.enumerateDevices())
    .filter(d => d.kind === "videoinput").map(d => ({ id: d.deviceId, label: d.label })),
  addCam: (deviceId = null, nome) => { adicionarCam({ deviceId, nome }); return cams.length; },
  setCamDevice: async (i, deviceId) => { const c = cams[i]; if (!c) return false; c.deviceId = deviceId; salvarCfg(); if (c.rodando) { c.parar(); await c.ligar(); } return true; },
  trocarModo: (m) => { if (m in MODOS) { modo = m; reiniciarTracking(); aplicarUi(); } },
};

// boot
$("build").textContent = BUILD;
cfg.cams.forEach(spec => adicionarCam(spec));
aplicarUi();
