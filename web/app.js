// Radar da Plateia — v3.5 web (multi-câmera, relatório de sessão, ruído, modo Segurança/EPI). Tudo roda NO NAVEGADOR.
import { FaceDetector, ObjectDetector, FilesetResolver } from "./vendor/tasks-vision/vision_bundle.mjs";
import {
  valido, dedupe, geometria, mediana, formataDur, zonas, fileirasECadeiras, resumoSessao, csvRelatorio,
  analisarCores, regioesEpi, regioesEpiPorRosto, rostoDaPessoa, amostraEpi, estadoEpi, rotuloEpi, fraseEpi, casarPorIou,
} from "./engine.js";

const BUILD = "RADAR_V3_BUILD_20260902F";

// ------------------------------------------------------------------ modos
const MODOS = {
  atencao: {
    nome: "Atenção", icone: "◉",
    desc: "Aula/palestra: marca quem fica sem olhar pra frente e avisa.",
    segundos: 10, contadores: [["ok", "Atentos"], ["alerta", "Dispersos"]], usaAlerta: true, taxa: "Atenção média",
  },
  exercicio: {
    nome: "Exercício", icone: "⌨",
    desc: "Mão na massa: todo mundo deve estar no notebook. Marca quem não está.",
    segundos: 15, contadores: [["ok", "No notebook"], ["alerta", "Fora do exercício"]], usaAlerta: true, taxa: "No notebook",
  },
  produtividade: {
    nome: "Produtividade", icone: "▤",
    desc: "Escritório: acompanha % de foco de cada pessoa ao longo do tempo.",
    segundos: 30, contadores: [["ok", "Focados"], ["alerta", "Sem foco"], ["neutro", "Foco médio"]], usaAlerta: true, taxa: "Foco médio",
  },
  postura: {
    nome: "Postura", icone: "⌛",
    desc: "Bem-estar: avisa quem está parado na mesma posição há tempo demais.",
    segundos: 300, contadores: [["ok", "Em movimento"], ["alerta", "Parados"]], usaAlerta: true, taxa: "Em movimento",
  },
  presenca: {
    nome: "Presença", icone: "▦",
    desc: "Contagem de pessoas ao vivo: agora, pico e evolução da sala.",
    segundos: 10, contadores: [["neutro", "Agora"], ["ok", "Pico"], ["neutro", "Média"]], usaAlerta: false, taxa: null,
  },
  seguranca: {
    nome: "Segurança", icone: "▲",
    desc: "Indústria/obra: detecta pessoas e avisa quem está sem colete ou capacete.",
    segundos: 15, contadores: [["ok", "Com EPI"], ["alerta", "Sem EPI"], ["neutro", "Pessoas"]], usaAlerta: true, taxa: "Conformidade",
    pessoas: true, // usa o detector de pessoas (corpo), não o de rostos
  },
};

const ENG = {
  conf: 0.28, minFacePx: 22, baselineS: 3, recoverS: 2, pessoaConf: 0.40,
  yawDev: 0.42, ghostStable: 5, ghostTtl: 16,
  pitchFrontalAbs: 0.35, moveFrac: 0.14,
  ruidoAlto: 70, ruidoBaixo: 15,
};

// ------------------------------------------------------------------ estado global
const agoraS = () => performance.now() / 1000;
const cfg = carregarCfg();
let modo = cfg.modo in MODOS ? cfg.modo : "atencao";
let rodando = false;
let detector = null;
let detectorPessoas = null, carregandoPessoas = null;
let ultimoAviso = -Infinity; // 0 travava o 1º aviso nos primeiros `gap` segundos após abrir a página (bug pego pelo e2e do modo Segurança)
let custoTick = [];
let amostrasPresenca = [];
let picoPresenca = 0;
let camCursor = 0;
let sessao = novaSessao();
const cams = [];
const erros = [];

const $ = (id) => document.getElementById(id);
const feedWrap = $("feed-wrap");
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ------------------------------------------------------------------ config persistente
function carregarCfg() {
  const base = {
    modo: "atencao", aviso: "voz", gap: 20, volume: 70, espelho: false, alcance: "longe", ruido: false,
    segundos: {}, cams: [{ deviceId: null, nome: "Câmera 1" }],
    epi: { colete: true, capacete: false, rigor: "normal" },
  };
  try {
    const s = JSON.parse(localStorage.getItem("radar.cfg.v1") || "{}");
    const out = { ...base, ...s, segundos: { ...(s.segundos || {}) }, epi: { ...base.epi, ...(s.epi || {}) } };
    if (!Array.isArray(s.cams) || !s.cams.length) out.cams = [{ deviceId: s.camera || null, nome: "Câmera 1" }];
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
if ("speechSynthesis" in window) { acharVozPt(); speechSynthesis.onvoiceschanged = acharVozPt; }
function falar(texto) {
  try {
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = "pt-BR"; u.rate = 1.05; u.volume = cfg.volume / 100;
    if (vozPt) u.voice = vozPt;
    speechSynthesis.speak(u);
  } catch (e) { erros.push("voz: " + e.message); apitar(); }
}
function emitirAviso(texto) {
  const agora = agoraS();
  if (agora - ultimoAviso < cfg.gap) return false;
  ultimoAviso = agora;
  if (cfg.aviso === "apito") apitar();
  else if (cfg.aviso === "voz") falar(texto);
  feedWrap.classList.remove("alerta-flash"); void feedWrap.offsetWidth;
  feedWrap.classList.add("alerta-flash");
  registrarLog(texto);
  sessao.avisos.push({ t: agora, texto });
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

// ------------------------------------------------------------------ ruído da sala (microfone)
const ruido = { ativo: false, nivel: null, analyser: null, stream: null, dados: null, altoDesde: null, baixoDesde: null, avisouAlto: false, avisouBaixo: false };
async function ligarRuido() {
  try {
    garantirAudio();
    ruido.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const src = audioCtx.createMediaStreamSource(ruido.stream);
    ruido.analyser = audioCtx.createAnalyser();
    ruido.analyser.fftSize = 1024;
    src.connect(ruido.analyser);
    ruido.dados = new Float32Array(ruido.analyser.fftSize);
    ruido.ativo = true;
    $("ruido-medidor").hidden = false;
  } catch (e) {
    registrarLog("microfone indisponível: " + e.message);
    cfg.ruido = false; $("chk-ruido").checked = false; salvarCfg();
  }
}
function desligarRuido() {
  ruido.ativo = false; ruido.nivel = null;
  ruido.stream?.getTracks().forEach(t => t.stop());
  ruido.stream = null;
  $("ruido-medidor").hidden = true;
}
function medirRuido(agora) {
  if (!ruido.ativo) return;
  ruido.analyser.getFloatTimeDomainData(ruido.dados);
  let s = 0; for (const v of ruido.dados) s += v * v;
  const db = 20 * Math.log10(Math.sqrt(s / ruido.dados.length) + 1e-8);      // ~-100 (silêncio) .. 0 (saturado)
  const nivel = Math.max(0, Math.min(100, Math.round((db + 60) / 60 * 100))); // -60 dB = 0, 0 dB = 100
  ruido.nivel = ruido.nivel == null ? nivel : Math.round(0.7 * ruido.nivel + 0.3 * nivel);
  $("ruido-fill").style.width = ruido.nivel + "%";
  $("ruido-fill").className = ruido.nivel >= ENG.ruidoAlto ? "alto" : ruido.nivel <= ENG.ruidoBaixo ? "baixo" : "";
  $("ruido-val").textContent = ruido.nivel;
  if (ruido.nivel >= ENG.ruidoAlto) {
    ruido.altoDesde ??= agora; ruido.baixoDesde = null; ruido.avisouBaixo = false;
    if (!ruido.avisouAlto && agora - ruido.altoDesde >= 5) { ruido.avisouAlto = true; registrarLog(`sala barulhenta (nível ${ruido.nivel})`); }
  } else if (ruido.nivel <= ENG.ruidoBaixo) {
    ruido.baixoDesde ??= agora; ruido.altoDesde = null; ruido.avisouAlto = false;
    if (!ruido.avisouBaixo && agora - ruido.baixoDesde >= 20) { ruido.avisouBaixo = true; registrarLog(`silêncio na sala há 20 segundos (nível ${ruido.nivel})`); }
  } else { ruido.altoDesde = null; ruido.baixoDesde = null; ruido.avisouAlto = false; ruido.avisouBaixo = false; }
}

// ------------------------------------------------------------------ detector (um só, compartilhado)
async function criarDetector() {
  const fileset = await FilesetResolver.forVisionTasks("vendor/tasks-vision/wasm");
  for (const delegate of ["GPU", "CPU"]) {
    try {
      return await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "vendor/models/blaze_face_short_range.tflite", delegate },
        runningMode: "IMAGE", minDetectionConfidence: ENG.conf,
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
function detectarTudo(cam) {
  const W = cam.video.videoWidth, H = cam.video.videoHeight;
  const saida = [];
  detectarRegiao(cam, 0, 0, W, H, saida);
  const zs = zonas(W, H, cfg.alcance);
  if (zs.length) {
    const porVolta = zs.length <= 4 ? zs.length : 3; // 3x3 em rodízio de 3 por volta
    for (let k = 0; k < porVolta; k++) {
      const [sx, sy, sw, sh] = zs[cam.tileCursor % zs.length];
      cam.tileCursor++;
      detectarRegiao(cam, sx, sy, sw, sh, saida);
    }
  }
  return dedupe(saida);
}

// ------------------------------------------------------------------ detector de PESSOAS (modo Segurança) — carrega só quando o modo pede
async function criarDetectorPessoas() {
  const fileset = await FilesetResolver.forVisionTasks("vendor/tasks-vision/wasm");
  for (const delegate of ["GPU", "CPU"]) {
    try {
      return await ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "vendor/models/efficientdet_lite0.tflite", delegate },
        runningMode: "IMAGE", scoreThreshold: ENG.pessoaConf, maxResults: 24, categoryAllowlist: ["person"],
      });
    } catch (e) { erros.push(`detector pessoas ${delegate}: ${e.message}`); }
  }
  throw new Error("não consegui iniciar o detector de pessoas");
}
function garantirDetectorPessoas() {
  if (detectorPessoas) return Promise.resolve();
  if (carregandoPessoas) return carregandoPessoas;
  setPill("pill-motor", "carregando");
  carregandoPessoas = criarDetectorPessoas()
    .then(d => { detectorPessoas = d; setPill("pill-motor", "on"); registrarLog("detector de pessoas pronto (modo Segurança)"); })
    .catch(e => { erros.push("motor pessoas: " + e.message); registrarLog("falha no detector de pessoas: " + e.message); setPill("pill-motor", "erro"); })
    .finally(() => { carregandoPessoas = null; });
  return carregandoPessoas;
}
function detectarPessoasRegiao(cam, sx, sy, sw, sh, saida) {
  const escala = Math.min(1, 640 / sw); // modelo usa 320px; 640 preserva pessoa pequena sem custo de cópia grande
  const dw = Math.max(1, Math.round(sw * escala)), dh = Math.max(1, Math.round(sh * escala));
  tileCanvas.width = dw; tileCanvas.height = dh;
  tileCtx.drawImage(cam.video, sx, sy, sw, sh, 0, 0, dw, dh);
  const res = detectorPessoas.detect(tileCanvas);
  for (const d of res.detections) {
    const bb = d.boundingBox;
    saida.push({ box: [bb.originX / escala + sx, bb.originY / escala + sy, bb.width / escala, bb.height / escala], kps: [], score: d.categories?.[0]?.score ?? 0 });
  }
}
function detectarPessoas(cam) {
  const W = cam.video.videoWidth, H = cam.video.videoHeight;
  const saida = [];
  detectarPessoasRegiao(cam, 0, 0, W, H, saida);
  if (cfg.alcance !== "perto") { // pessoa é grande: 2x2 basta, 1 zona por volta em rodízio
    const zs = zonas(W, H, "medio");
    const [sx, sy, sw, sh] = zs[cam.tileCursor % zs.length]; cam.tileCursor++;
    detectarPessoasRegiao(cam, sx, sy, sw, sh, saida);
  }
  return dedupe(saida, "area"); // zona corta o corpo: a caixa inteira (maior) vence a parcial, mesmo com score menor
}
const amostraCanvas = document.createElement("canvas");
const amostraCtx = amostraCanvas.getContext("2d", { willReadFrequently: true });
/** Lê as cores do torso (colete) e do topo (capacete) de cada pessoa numa cópia reduzida do quadro. Regiões ancoradas no rosto quando há um. */
function amostrarEpi(cam, dets, rostos = []) {
  if (!dets.length) return;
  const W = cam.video.videoWidth, H = cam.video.videoHeight;
  const escala = Math.min(1, 640 / W);
  const dw = Math.round(W * escala), dh = Math.round(H * escala);
  amostraCanvas.width = dw; amostraCanvas.height = dh;
  amostraCtx.drawImage(cam.video, 0, 0, dw, dh);
  const pega = ([x, y, w, h]) => {
    const gx = Math.max(0, Math.min(Math.round(x * escala), dw - 2)), gy = Math.max(0, Math.min(Math.round(y * escala), dh - 2));
    const gw = Math.max(2, Math.min(Math.round(w * escala), dw - gx)), gh = Math.max(2, Math.min(Math.round(h * escala), dh - gy));
    return analisarCores(amostraCtx.getImageData(gx, gy, gw, gh).data);
  };
  for (const d of dets) {
    const rosto = rostoDaPessoa(d.box, rostos);
    const porRosto = rosto ? regioesEpiPorRosto(d.box, rosto) : null;
    d.regioes = porRosto || regioesEpi(d.box);
    d.ancora = porRosto ? "rosto" : "caixa";
    d.epi = amostraEpi({ torso: pega(d.regioes.colete), topo: pega(d.regioes.capacete) }, cfg.epi.rigor);
    if (porRosto && !porRosto.torsoVisivel) d.epi.colete = null;     // torso fora do quadro: sem leitura, não "sem colete"
    if (porRosto && !porRosto.cabecaVisivel) d.epi.capacete = null;
  }
}

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
    if (tr.sumido > 1.6) { // folga pro rodízio de zonas e de câmeras
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
/** Tracker de pessoas (corpo inteiro): casa por sobreposição, guarda histórico de leituras de EPI. */
function atualizarTracksPessoas(cam, dets, agora) {
  const { pares, livres } = casarPorIou(cam.tracks, dets, 0.2);
  for (const [tr, d] of pares) {
    tr.box = d.box; tr.visto = agora; tr.regioes = d.regioes; tr.ancora = d.ancora;
    tr.score = 0.8 * tr.score + 0.2 * d.score;
    tr.hist.push(d.epi); if (tr.hist.length > 8) tr.hist.shift();
  }
  for (const d of livres) {
    cam.tracks.push({
      id: cam.proximoId++, box: d.box, kps: [], score: d.score, inicio: agora, visto: agora,
      hist: [d.epi], regioes: d.regioes, ancora: d.ancora, faltando: [], semEpiDesde: null, avisado: false,
      ghost: false, sumido: 0, focoS: 0, totalS: 0, semEpiS: 0, ultimoTick: agora,
    });
  }
  cam.tracks = cam.tracks.filter(tr => agora - tr.visto <= 2.0); // folga pro rodízio de câmeras
}
function posicaoNaSala(cam, alvo) { return fileirasECadeiras(cam.tracks).get(alvo) || null; }
function ondeFica(cam, tr) {
  const pos = posicaoNaSala(cam, tr);
  const lugar = !pos ? "Alguém"
    : modo === "seguranca" ? `Posição ${pos[1]} da esquerda${pos[0] > 1 ? `, fila ${pos[0]}` : ""}`
    : `Fileira ${pos[0]}, cadeira ${pos[1]} contando da sua esquerda`;
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
/** Modo Segurança: "Sem EPI" conta na hora (é o estado real); o AVISO espera T segundos (tolera passagem/oclusão). */
function avaliarSeguranca(cam, agora) {
  const T = segundosDoModo();
  let bons = 0, ruins = 0;
  for (const tr of cam.tracks) {
    const dt = Math.min(agora - tr.ultimoTick, 1); tr.ultimoTick = agora;
    const est = estadoEpi(tr.hist, cfg.epi);
    tr.faltando = est.faltando;
    if (est.conforme === null) {
      tr.estado = "calib";
      tr.rotulo = est.indefinidos.length ? `SEM LEITURA (${est.indefinidos.includes("colete") ? "torso" : "cabeça"} fora do quadro)` : "lendo…";
      continue;
    }
    tr.totalS += dt;
    if (est.conforme) {
      tr.semEpiDesde = null; tr.avisado = false; tr.estado = "ok"; tr.rotulo = "EPI OK"; bons++; continue;
    }
    tr.semEpiS += dt; ruins++;
    tr.semEpiDesde ??= agora;
    const s = agora - tr.semEpiDesde, flag = s >= T;
    tr.estado = flag ? "flag" : "warn";
    tr.rotulo = `${rotuloEpi(est.faltando)} ${Math.floor(s)}s`;
    if (flag && !tr.avisado) {
      const frase = `${ondeFica(cam, tr)}: sem ${fraseEpi(est.faltando)} há mais de ${Math.round(T)} segundos.`;
      if (emitirAviso(frase)) tr.avisado = true;
    }
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
    if (modo === "seguranca" && tr.regioes && tr.faltando?.length) { // mostra ONDE procurou o EPI que falta
      ctx.setLineDash([4, 4]); ctx.globalAlpha = 0.7;
      for (const item of tr.faltando) { const [rx, ry, rw, rh] = tr.regioes[item]; ctx.strokeRect(rx, ry, rw, rh); }
      ctx.globalAlpha = 1; ctx.setLineDash([]);
    }
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
      <div class="cell-video"><video playsinline muted></video><canvas></canvas><div class="cell-msg" hidden></div></div>`;
    this.video = this.el.querySelector("video");
    this.canvas = this.el.querySelector("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.meta = this.el.querySelector(".cell-meta");
    this.msg = this.el.querySelector(".cell-msg");
    this.sel = this.el.querySelector(".cell-dev");
    this.el.querySelector(".cell-nome").addEventListener("input", (e) => { this.nome = e.target.value.trim() || this.nome; salvarCfg(); });
    this.sel.addEventListener("change", async () => {
      this.deviceId = this.sel.value || null; salvarCfg();
      if (this.rodando) { this.parar(); await this.ligar(); }
    });
    this.el.querySelector(".cell-x").addEventListener("click", () => removerCam(this));
    $("feeds").appendChild(this.el);
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
        video: { deviceId: this.deviceId ? { exact: this.deviceId } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 } },
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
      this.msg.textContent = this.erro; this.msg.hidden = false; this.meta.textContent = "erro";
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
    let dets, r;
    if (MODOS[modo].pessoas) {
      if (!detectorPessoas) { garantirDetectorPessoas(); return { bons: 0, ruins: 0 }; }
      dets = detectarPessoas(this);
      // rosto ancora as regiões de colete/capacete (proporção da caixa erra em gente sentada/perto):
      // procura o rosto DENTRO da metade de cima de cada pessoa (recorte = rosto maior pro modelo de curto alcance)
      const rostos = [];
      const W = this.video.videoWidth, H = this.video.videoHeight;
      for (const d of dets) {
        const [bx, by, bw, bh] = d.box;
        const sx = Math.max(0, Math.round(bx)), sy = Math.max(0, Math.round(by));
        const sw = Math.min(W - sx, Math.round(bw)), sh = Math.min(H - sy, Math.round(bh * 0.7));
        if (sw > 16 && sh > 16) detectarRegiao(this, sx, sy, sw, sh, rostos);
      }
      amostrarEpi(this, dets, rostos.filter(valido));
      this.lastFaces = dets.length;
      atualizarTracksPessoas(this, dets, agora);
      r = avaliarSeguranca(this, agora);
    } else {
      dets = detectarTudo(this);
      this.lastFaces = dets.length;
      atualizarTracks(this, dets, agora);
      r = avaliar(this, agora);
    }
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
  // no modo Segurança, pessoa só conta depois de 3 leituras (tira o pisca de detecção espúria do contador)
  pessoas() { return this.tracks.filter(t => !t.ghost && valido(t) && (!MODOS[modo].pessoas || (t.hist?.length ?? 0) >= 3)).length; }
}
function atualizarGrade() { $("feeds").dataset.n = Math.min(cams.length, 4); }
function adicionarCam(spec = {}) {
  const cam = new Cam(spec);
  cams.push(cam);
  atualizarGrade(); salvarCfg(); listarCameras();
  if (rodando) cam.ligar();
  return cam;
}
function removerCam(cam) {
  cam.parar(); cam.el.remove();
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
const totalPessoas = () => cams.reduce((s, c) => s + c.pessoas(), 0);

// ------------------------------------------------------------------ contadores e stats (agregados)
function renderContadores(bons, ruins) {
  const m = MODOS[modo];
  let vals;
  if (modo === "presenca") {
    const agora = totalPessoas();
    picoPresenca = Math.max(picoPresenca, agora);
    const media = amostrasPresenca.length ? Math.round(amostrasPresenca.reduce((s, a) => s + a[1], 0) / amostrasPresenca.length) : agora;
    vals = [agora, picoPresenca, media];
  } else if (modo === "produtividade") {
    const pcts = cams.flatMap(c => c.tracks).filter(t => t.totalS > 10).map(t => t.focoS / t.totalS);
    const medio = pcts.length ? Math.round(100 * pcts.reduce((s, p) => s + p, 0) / pcts.length) : 100;
    vals = [bons, ruins, medio + "%"];
  } else if (modo === "seguranca") vals = [bons, ruins, totalPessoas()];
  else vals = [bons, ruins];
  $("contadores").innerHTML = m.contadores.map(([cls, rot], i) =>
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
        <span class="barra"><i style="width:${Math.round(pct * 100)}%"></i></span><span>${Math.round(pct * 100)}%</span></div>`;
    }).join("") : `<p class="dica">acumulando… aparece após 10s de cada pessoa</p>`;
  } else if (modo === "seguranca") {
    painel.hidden = false; $("stats-titulo").textContent = "EPI por pessoa (% do tempo em conformidade)";
    const linhas = cams.flatMap(cam => cam.tracks.filter(t => t.totalS > 5).map(t => ({ cam, t, pct: 1 - t.semEpiS / t.totalS })))
      .sort((a, b) => a.pct - b.pct).slice(0, 14);
    corpo.innerHTML = linhas.length ? linhas.map(({ cam, t, pct }) => {
      const pos = posicaoNaSala(cam, t);
      const nome = (cams.length > 1 ? esc(cam.nome) + " " : "") + (pos ? `P${pos[1]}` : `#${t.id}`) + (t.faltando?.length ? ` · ${esc(rotuloEpi(t.faltando).toLowerCase())}` : "");
      return `<div class="stat-linha ${pct < 0.6 ? "ruim" : ""}"><span>${nome}</span>
        <span class="barra"><i style="width:${Math.round(pct * 100)}%"></i></span><span>${Math.round(pct * 100)}%</span></div>`;
    }).join("") : `<p class="dica">acumulando… aparece após 5s de cada pessoa</p>`;
  } else if (modo === "presenca") {
    painel.hidden = false; $("stats-titulo").textContent = cams.length > 1 ? "Evolução (todas as câmeras)" : "Evolução da sala";
    if (!$("spark")) corpo.innerHTML = `<canvas id="spark" class="curva"></canvas>`;
    desenharCurva($("spark"), amostrasPresenca.map(a => a[1]), Math.max(picoPresenca, 1));
  } else painel.hidden = true;
}
function desenharCurva(c, valores, max, cor = "#3ee0ff") {
  if (!c) return;
  const w = c.width = c.clientWidth || 300, h = c.height = 64;
  const g = c.getContext("2d");
  g.clearRect(0, 0, w, h);
  if (valores.length < 2) return;
  g.beginPath();
  valores.forEach((n, i) => {
    const x = (i / (valores.length - 1)) * (w - 4) + 2, y = h - 4 - (n / max) * (h - 10);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.strokeStyle = cor; g.lineWidth = 2; g.stroke();
}

// ------------------------------------------------------------------ relatório da sessão
function novaSessao() { return { inicio: agoraS(), inicioWall: Date.now(), passoS: 5, amostras: [], avisos: [] }; }
const horaDe = (t) => new Date(sessao.inicioWall + (t - sessao.inicio) * 1000).toLocaleTimeString("pt-BR");
function amostrarSessao(agora, bons, ruins) {
  const ult = sessao.amostras[sessao.amostras.length - 1];
  if (ult && agora - ult.t < sessao.passoS) return;
  sessao.amostras.push({ t: agora, pessoas: totalPessoas(), ok: bons, alerta: ruins, ruido: ruido.ativo ? ruido.nivel : null });
}
function renderRelatorio(agora) {
  const r = resumoSessao(sessao, agora);
  const m = MODOS[modo];
  const pct = r.taxa == null ? "—" : Math.round(r.taxa * 100) + "%";
  const itens = [
    ["Duração", formataDur(r.duracaoS)],
    ["Pessoas (pico)", r.pico],
  ];
  if (m.taxa) itens.push([m.taxa, pct], ["Nota", r.nota.rotulo, r.nota.cor]);
  else itens.push(["Média de pessoas", r.mediaPessoas.toFixed(1)]);
  if (m.usaAlerta) itens.push(["Minutos com alerta", r.minutosComAlerta.toFixed(1)], ["Avisos emitidos", r.avisos]);
  if (r.ruidoMedio != null) itens.push(["Ruído médio", Math.round(r.ruidoMedio)]);
  $("rel-grid").innerHTML = itens.map(([k, v, cor]) =>
    `<div class="rel-item ${cor || ""}"><span class="rel-v">${esc(v)}</span><span class="rel-k">${esc(k)}</span></div>`).join("");
  const serie = sessao.amostras.map(a => a.ok + a.alerta ? 100 * a.ok / (a.ok + a.alerta) : (a.pessoas ? 100 : 0));
  desenharCurva($("curva"), m.taxa ? serie : sessao.amostras.map(a => a.pessoas), m.taxa ? 100 : Math.max(r.pico, 1), "#34e08c");
  $("btn-csv").disabled = !sessao.amostras.length;
}
function baixarCsv() {
  const csv = csvRelatorio(sessao, modo, horaDe);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  const d = new Date(sessao.inicioWall), p = (n) => String(n).padStart(2, "0");
  a.href = URL.createObjectURL(blob);
  a.download = `radar-${modo}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  registrarLog(`relatório exportado (${sessao.amostras.length} amostras, ${sessao.avisos.length} avisos)`);
}

// ------------------------------------------------------------------ loop único
let ultimoRender = 0;
function loop() {
  if (!rodando) return;
  const t0 = performance.now();
  try {
    const agora = agoraS();
    // uma câmera por volta (rodízio): o custo por volta fica o de 1 câmera, cada uma atualiza a cada N voltas
    const ativas = cams.filter(c => c.rodando);
    if (ativas.length) { ativas[camCursor % ativas.length].tick(agora); camCursor++; }
    const bons = ativas.reduce((s, c) => s + c.bons, 0), ruins = ativas.reduce((s, c) => s + c.ruins, 0);
    medirRuido(agora);
    renderContadores(bons, ruins);
    renderStats();
    amostrarSessao(agora, bons, ruins);
    if (agora - ultimoRender >= 2) { ultimoRender = agora; renderRelatorio(agora); }
    if (modo === "presenca" && (!amostrasPresenca.length || agora - amostrasPresenca[amostrasPresenca.length - 1][0] >= 2)) {
      amostrasPresenca.push([agora, totalPessoas()]);
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
    if (MODOS[modo].pessoas) await garantirDetectorPessoas();
    let ok = 0;
    for (const cam of cams) if (await cam.ligar()) ok++;
    await listarCameras();
    if (ok) {
      $("feed-vazio").hidden = true; $("btn-fs").hidden = false; $("btn-parar").hidden = false;
      setPill("pill-camera", "on");
      $("pill-camera").lastChild.textContent = ok > 1 ? `${ok} CÂMERAS` : `CÂMERA ${cams[0].res}`;
      rodando = true; custoTick = []; amostrasPresenca = []; picoPresenca = 0;
      sessao = novaSessao(); ultimoRender = 0;
      if (cfg.ruido) await ligarRuido();
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
  desligarRuido();
  renderRelatorio(agoraS());
  $("feed-vazio").hidden = false;
  $("feed-msg").innerHTML = "Câmeras paradas. O relatório da sessão está no painel ao lado. Clique em <strong>Ligar câmeras</strong> pra começar outra.";
  $("btn-parar").hidden = true; $("btn-fs").hidden = true;
  setPill("pill-camera", "off");
  $("pill-camera").lastChild.textContent = "CÂMERA";
}

// ------------------------------------------------------------------ UI
function renderModos() {
  $("modos").innerHTML = Object.entries(MODOS).map(([k, m]) => `
    <button class="modo ${k === modo ? "ativo" : ""}" data-modo="${k}">
      <span class="icone">${m.icone}</span><span class="nome">Modo ${m.nome}</span><span class="desc">${m.desc}</span>
    </button>`).join("");
}
function aplicarUi() {
  renderModos();
  const T = segundosDoModo();
  $("inp-seg").value = T; $("lbl-seg").textContent = formataDur(T);
  $("inp-gap").value = cfg.gap; $("lbl-gap").textContent = cfg.gap + "s";
  $("inp-vol").value = cfg.volume; $("lbl-vol").textContent = cfg.volume + "%";
  $("chk-espelho").checked = cfg.espelho;
  $("chk-ruido").checked = cfg.ruido;
  $("feeds").classList.toggle("espelhado", cfg.espelho);
  document.querySelectorAll("#seg-aviso button").forEach(b => b.classList.toggle("ativo", b.dataset.v === cfg.aviso));
  document.querySelectorAll("#seg-alcance button").forEach(b => b.classList.toggle("ativo", b.dataset.v === cfg.alcance));
  $("campo-epi").hidden = modo !== "seguranca";
  $("chk-epi-colete").checked = !!cfg.epi.colete; $("chk-epi-capacete").checked = !!cfg.epi.capacete;
  document.querySelectorAll("#seg-rigor button").forEach(b => b.classList.toggle("ativo", b.dataset.v === cfg.epi.rigor));
  renderContadores(0, 0); renderStats(); renderRelatorio(agoraS());
}
function entrarNoModo(m) {
  modo = m; reiniciarTracking(); salvarCfg(); aplicarUi();
  if (MODOS[modo].pessoas && !detectorPessoas) garantirDetectorPessoas();
}
function reiniciarTracking() {
  cams.forEach(c => { c.tracks = []; c.tileCursor = 0; });
  amostrasPresenca = []; picoPresenca = 0; custoTick = [];
}

$("modos").addEventListener("click", (ev) => {
  const b = ev.target.closest(".modo"); if (!b) return;
  entrarNoModo(b.dataset.modo);
  registrarLog(`modo trocado: ${MODOS[modo].nome} (regra ${formataDur(segundosDoModo())})`);
});
$("chk-epi-colete").addEventListener("change", () => { cfg.epi.colete = $("chk-epi-colete").checked; if (!cfg.epi.colete && !cfg.epi.capacete) { cfg.epi.colete = true; $("chk-epi-colete").checked = true; } salvarCfg(); });
$("chk-epi-capacete").addEventListener("change", () => { cfg.epi.capacete = $("chk-epi-capacete").checked; salvarCfg(); });
$("seg-rigor").addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  cfg.epi.rigor = b.dataset.v; salvarCfg(); aplicarUi();
});
$("inp-seg").addEventListener("input", () => { cfg.segundos[modo] = Number($("inp-seg").value); $("lbl-seg").textContent = formataDur(segundosDoModo()); salvarCfg(); });
$("seg-aviso").addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  cfg.aviso = b.dataset.v; salvarCfg(); aplicarUi();
  if (cfg.aviso === "apito") apitar();
  if (cfg.aviso === "voz") falar("Avisos por voz.");
});
$("seg-alcance").addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  cfg.alcance = b.dataset.v; cams.forEach(c => c.tileCursor = 0); custoTick = []; salvarCfg(); aplicarUi();
});
$("inp-gap").addEventListener("input", () => { cfg.gap = Number($("inp-gap").value); $("lbl-gap").textContent = cfg.gap + "s"; salvarCfg(); });
$("inp-vol").addEventListener("input", () => { cfg.volume = Number($("inp-vol").value); $("lbl-vol").textContent = cfg.volume + "%"; salvarCfg(); });
$("chk-espelho").addEventListener("change", () => { cfg.espelho = $("chk-espelho").checked; salvarCfg(); aplicarUi(); });
$("chk-ruido").addEventListener("change", async () => {
  cfg.ruido = $("chk-ruido").checked; salvarCfg();
  if (cfg.ruido && rodando) await ligarRuido();
  if (!cfg.ruido) desligarRuido();
});
$("btn-ligar").addEventListener("click", ligarTudo);
$("btn-parar").addEventListener("click", pararTudo);
$("btn-add-cam").addEventListener("click", () => adicionarCam({ nome: `Câmera ${cams.length + 1}` }));
$("btn-csv").addEventListener("click", baixarCsv);
$("btn-fs").addEventListener("click", () => { document.fullscreenElement ? document.exitFullscreen() : feedWrap.requestFullscreen(); });
$("btn-limpar").addEventListener("click", () => { $("log").innerHTML = `<li class="vazio">nenhum aviso ainda</li>`; });

// debug / teste automatizado
window.__radar = {
  get estado() {
    return {
      build: BUILD, rodando, modo, engineOk: !!detector, pessoasOk: !!detectorPessoas, erros: [...erros],
      sessao: { amostras: sessao.amostras.length, avisos: sessao.avisos.length, ultimoAviso: sessao.avisos[sessao.avisos.length - 1]?.texto ?? null },
      ruido: ruido.ativo ? ruido.nivel : null,
      epi: { ...cfg.epi, segundos: segundosDoModo() },
      cams: cams.map(c => ({ nome: c.nome, rodando: c.rodando, res: c.res, lastFaces: c.lastFaces,
                             tracks: c.tracks.length, validos: c.tracks.filter(valido).length,
                             pessoas: c.tracks.map(t => ({ id: t.id, estado: t.estado ?? null, faltando: t.faltando ?? null, hist: t.hist?.length ?? 0, ancora: t.ancora ?? null })),
                             bons: c.bons, ruins: c.ruins, fps: Number(c.fps.toFixed(1)), erro: c.erro,
                             videoT: Number(c.video.currentTime.toFixed(1)), videoRs: c.video.readyState,
                             trackState: c.stream?.getVideoTracks()[0]?.readyState ?? null })),
    };
  },
  csv: () => csvRelatorio(sessao, modo, horaDe),
  devices: async () => (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput").map(d => ({ id: d.deviceId, label: d.label })),
  addCam: (deviceId = null, nome) => { adicionarCam({ deviceId, nome }); return cams.length; },
  setCamDevice: async (i, deviceId) => { const c = cams[i]; if (!c) return false; c.deviceId = deviceId; salvarCfg(); if (c.rodando) { c.parar(); await c.ligar(); } return true; },
  trocarModo: (m) => { if (m in MODOS) entrarNoModo(m); },
  setSegundos: (n) => { cfg.segundos[modo] = Number(n); aplicarUi(); },
  setEpi: (o) => { Object.assign(cfg.epi, o); salvarCfg(); aplicarUi(); },
};

// boot
$("build").textContent = BUILD;
cfg.cams.forEach(spec => adicionarCam(spec));
aplicarUi();
