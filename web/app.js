// Radar da Plateia — v3.5 web (multi-câmera, relatório de sessão, ruído, modo Segurança/EPI). Tudo roda NO NAVEGADOR.
import { FaceDetector, ObjectDetector, FilesetResolver } from "./vendor/tasks-vision/vision_bundle.mjs";
import {
  valido, dedupe, geometria, mediana, formataDur, zonas, fileirasECadeiras, resumoSessao, csvRelatorio,
  analisarCores, regioesEpi, regioesEpiPorRosto, rostoDaPessoa, amostraEpi, estadoEpi, rotuloEpi, fraseEpi, casarPorIou,
  detectarPico, pontosDeQueda, alertaSala, acumularHeat, gradeHeatmap, postoDe, normalizarRect,
  maisProximo, votarNome, resumoPresenca, compactarSessao, expandirHeat,
} from "./engine.js";
import { salvarSessao, listarSessoes, apagarSessao } from "./historico.js";

const BUILD = "RADAR_V3_BUILD_20260902G";

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
  picoMin: 80, picoSalto: 30, picoGapS: 10, // grito/pico: nível bruto >= 80 e salto >= 30 sobre a mediana dos 2 s anteriores
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
    modo: "atencao", aviso: "voz", voz: "", gap: 20, volume: 70, espelho: false, alcance: "longe", ruido: false, pico: true,
    salaPct: 60, // alerta coletivo: taxa da sala abaixo disso por 30 s (0 = desligado)
    segundos: {}, cams: [{ deviceId: null, nome: "Câmera 1" }],
    postos: {}, // chave da câmera -> [{id, nome, box normalizado}]
    facial: false, consent: false, // reconhecimento facial: só liga com os dois true
    epi: { colete: true, capacete: false, rigor: "normal" },
  };
  try {
    const s = JSON.parse(localStorage.getItem("radar.cfg.v1") || "{}");
    const out = { ...base, ...s, segundos: { ...(s.segundos || {}) }, epi: { ...base.epi, ...(s.epi || {}) }, postos: { ...(s.postos || {}) } };
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
const vozesPt = () => ("speechSynthesis" in window ? speechSynthesis.getVoices() : []).filter(v => /^pt/i.test(v.lang));
/**
 * Escolha da voz (Eric, 02/09/2026: a voz online do Google no Chrome sai picotada). Ordem automática:
 * Antonio (a mesma voz neural do avisar-voz — existe no Edge como "Microsoft Antonio Online (Natural)") > outra "Natural" >
 * Microsoft LOCAL (Daniel/Maria, offline, sem cortes) > qualquer pt-BR > Google por último. `cfg.voz` = nome escolhido na UI.
 */
function acharVozPt() {
  const vs = vozesPt();
  const pref = cfg.voz && vs.find(v => v.name === cfg.voz);
  vozPt = pref
    || vs.find(v => /antonio/i.test(v.name))
    || vs.find(v => /natural/i.test(v.name) && v.lang === "pt-BR")
    || vs.find(v => /microsoft/i.test(v.name) && v.lang === "pt-BR")
    || vs.find(v => v.lang === "pt-BR" && !/google/i.test(v.name))
    || vs.find(v => v.lang === "pt-BR") || vs[0] || null;
  renderVozes();
}
function renderVozes() {
  const sel = $("sel-voz"); if (!sel) return;
  const vs = vozesPt();
  const limpo = (n) => n.replace(/Microsoft |Online |\(Natural\) |- Portuguese \(Brazil\)/g, "").trim();
  const auto = vozPt ? " (" + esc(limpo(vozPt.name)) + ")" : "";
  sel.innerHTML = `<option value="">automática${auto}</option>`
    + vs.map(v => `<option value="${esc(v.name)}">${esc(v.name)}${v.localService ? "" : " · online"}</option>`).join("");
  sel.value = cfg.voz && vs.some(v => v.name === cfg.voz) ? cfg.voz : "";
}
if ("speechSynthesis" in window) { speechSynthesis.onvoiceschanged = acharVozPt; }
function falar(texto) {
  try {
    if (!vozPt) acharVozPt();
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = "pt-BR"; u.rate = 1.0; u.volume = cfg.volume / 100;
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
const ruido = { ativo: false, nivel: null, analyser: null, stream: null, dados: null, altoDesde: null, baixoDesde: null, avisouAlto: false, avisouBaixo: false,
                hist: [], ultimoPico: -Infinity };
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
  ruido.ativo = false; ruido.nivel = null; ruido.hist = [];
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
  // grito / pico: usa o nível BRUTO (o suavizado esconde o salto)
  ruido.hist.push({ t: agora, nivel });
  while (ruido.hist.length && ruido.hist[0].t < agora - 3) ruido.hist.shift();
  if (cfg.pico && agora - ruido.ultimoPico >= ENG.picoGapS) {
    const p = detectarPico(ruido.hist, agora, { minimo: ENG.picoMin, salto: ENG.picoSalto });
    if (p.pico) {
      ruido.ultimoPico = agora; sessao.picos++;
      const texto = `Pico de ruído na sala: grito ou barulho forte (nível ${p.nivel}, fundo ${p.base}).`;
      if (!emitirAviso(texto)) { registrarLog(texto); sessao.avisos.push({ t: agora, texto }); }
    }
  }
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
    d.rosto = rosto; // reaproveitado pelo reconhecimento facial
    const porRosto = rosto ? regioesEpiPorRosto(d.box, rosto) : null;
    d.regioes = porRosto || regioesEpi(d.box);
    d.ancora = porRosto ? "rosto" : "caixa";
    d.epi = amostraEpi({ torso: pega(d.regioes.colete), topo: pega(d.regioes.capacete) }, cfg.epi.rigor);
    if (porRosto && !porRosto.torsoVisivel) d.epi.colete = null;     // torso fora do quadro: sem leitura, não "sem colete"
    if (porRosto && !porRosto.cabecaVisivel) d.epi.capacete = null;
  }
}

// ------------------------------------------------------------------ reconhecimento facial (opt-in, consentimento, 100% local)
// face-api (MIT, @vladmandic/face-api 1.7.15) carregado SOB DEMANDA: bundle 1,3 MB + modelos 6,5 MB só quando o cliente liga.
const recon = { api: null, pronto: false, carregando: null, ocupado: false, pessoas: carregarPessoas(), erro: null };
function carregarPessoas() {
  try { const p = JSON.parse(localStorage.getItem("radar.pessoas.v1") || "[]"); return Array.isArray(p) ? p : []; } catch { return []; }
}
function salvarPessoas() { try { localStorage.setItem("radar.pessoas.v1", JSON.stringify(recon.pessoas)); } catch { /* modo anônimo */ } renderPessoas(); }
const facialLigado = () => cfg.facial && cfg.consent;
function garantirFaceApi() {
  if (recon.pronto) return Promise.resolve(true);
  if (recon.carregando) return recon.carregando;
  $("facial-status").textContent = "carregando modelo…";
  recon.carregando = (async () => {
    const api = await import("./vendor/face-api/face-api.esm.js");
    // o bundle registra o backend wasm como prioridade mas não o inicializa (precisaria baixar .wasm): força webgl, senão cpu
    try { await api.tf.setBackend("webgl"); await api.tf.ready(); } catch { await api.tf.setBackend("cpu"); await api.tf.ready(); }
    if (!["webgl", "cpu"].includes(api.tf.getBackend())) { await api.tf.setBackend("cpu"); await api.tf.ready(); }
    await api.nets.faceLandmark68TinyNet.loadFromUri("vendor/face-api/model");
    await api.nets.faceRecognitionNet.loadFromUri("vendor/face-api/model");
    recon.api = api; recon.pronto = true;
    registrarLog(`reconhecimento facial pronto (motor ${api.tf?.getBackend?.() || "?"}, ${recon.pessoas.length} cadastrado(s))`);
    renderPessoas();
    return true;
  })().catch(e => { recon.erro = e.message; erros.push("face-api: " + e.message); registrarLog("falha no reconhecimento facial: " + e.message); renderPessoas(); return false; })
    .finally(() => { recon.carregando = null; });
  return recon.carregando;
}
/** Assinatura (128 números) do rosto dentro de `box` no vídeo da câmera: recorte com margem, alinhamento por marcos, FaceNet. */
async function assinaturaDoRosto(cam, box) {
  const [x, y, w, h] = box, m = 0.35;
  const W = cam.video.videoWidth, H = cam.video.videoHeight;
  const sx = Math.max(0, x - w * m), sy = Math.max(0, y - h * m);
  const sw = Math.min(W - sx, w * (1 + 2 * m)), sh = Math.min(H - sy, h * (1 + 2 * m));
  const c = document.createElement("canvas"); c.width = 224; c.height = Math.max(32, Math.round(224 * sh / sw));
  c.getContext("2d").drawImage(cam.video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  let alvo = c;
  try {
    const lm = await recon.api.detectFaceLandmarksTiny(c);
    if (lm) { const faces = await recon.api.extractFaces(c, [lm.align()]); if (faces[0]) alvo = faces[0]; }
  } catch (e) { erros.push("marcos faciais: " + e.message); }
  return Array.from(await recon.api.computeFaceDescriptor(alvo));
}
const rostoDoTrack = (tr) => MODOS[modo].pessoas ? tr.rostoBox : tr.box;
/** Uma leitura por volta, no máximo; cada pessoa relida a cada ~2,5 s; nome só fixa com maioria (votarNome). */
function reconhecer(cam, agora) {
  if (!facialLigado() || !recon.pronto || recon.ocupado || !recon.pessoas.length) return;
  const tr = cam.tracks.find(t => valido(t) && !t.ghost && rostoDoTrack(t) && rostoDoTrack(t)[2] >= 50 && agora - (t.reconEm ?? -Infinity) >= 2.5);
  if (!tr) return;
  tr.reconEm = agora; recon.ocupado = true;
  assinaturaDoRosto(cam, rostoDoTrack(tr)).then(desc => {
    const r = maisProximo(desc, recon.pessoas);
    tr.votos = [...(tr.votos || []), r ? r.pessoa.nome : null].slice(-5);
    const antes = tr.pessoa; tr.pessoa = votarNome(tr.votos);
    if (tr.pessoa && tr.pessoa !== antes) registrarLog(`${cams.length > 1 ? cam.nome + ": " : ""}${tr.pessoa} reconhecido(a)`);
  }).catch(e => erros.push("reconhecer: " + e.message)).finally(() => { recon.ocupado = false; });
}
async function cadastrarRosto(idx, nome, pessoaId = null) {
  const cam = cams[idx]; nome = (nome || "").trim();
  if (!cam || !cam.rodando) return { ok: false, motivo: "câmera não está ligada" };
  if (!facialLigado()) return { ok: false, motivo: "ligue o reconhecimento e confirme o consentimento" };
  if (!(await garantirFaceApi())) return { ok: false, motivo: "modelo não carregou: " + recon.erro };
  const agora = agoraS(); // só rostos estáveis (>= 1,5 s na tela): detecção espúria de 1 quadro não conta como "outra pessoa"
  const estaveis = cam.tracks.filter(t => valido(t) && !t.ghost && rostoDoTrack(t) && agora - t.inicio >= 1.5)
    .sort((a, b) => b.box[2] - a.box[2]);
  // quem cadastra está perto da câmera = o MAIOR rosto. Outro rosto só conta como "outra pessoa" se for comparável
  // (>= 60% da largura E >= 80% do score): falso rosto em estampa/textura (menor e menos confiante) não bloqueia o cadastro.
  const rostos = estaveis.filter((t, i) => i === 0 || (t.box[2] >= 0.6 * estaveis[0].box[2] && t.score >= 0.8 * estaveis[0].score));
  if (rostos.length !== 1) return { ok: false, motivo: rostos.length ? `há ${rostos.length} rostos na câmera — precisa estar sozinho` : "nenhum rosto estável na câmera (espere 2 s de frente pra ela)" };
  if (!pessoaId && !nome) return { ok: false, motivo: "dê um nome" };
  const desc = await assinaturaDoRosto(cam, rostoDoTrack(rostos[0]));
  let p = pessoaId ? recon.pessoas.find(x => x.id === pessoaId) : recon.pessoas.find(x => x.nome.toLowerCase() === nome.toLowerCase());
  if (!p) { p = { id: Math.random().toString(36).slice(2, 8), nome, descs: [], consentEm: Date.now() }; recon.pessoas.push(p); }
  p.descs.push(desc); if (p.descs.length > 6) p.descs.shift();
  salvarPessoas();
  registrarLog(`rosto cadastrado: ${p.nome} (${p.descs.length} amostra${p.descs.length > 1 ? "s" : ""})`);
  return { ok: true, pessoa: p.nome, amostras: p.descs.length };
}
function renderPessoas() {
  const ul = $("lista-pessoas");
  const st = $("facial-status");
  st.textContent = !facialLigado() ? "" : recon.pronto ? `pronto · ${recon.pessoas.length} cadastrado(s)` : recon.erro ? "falhou" : recon.carregando ? "carregando modelo…" : "";
  ul.innerHTML = recon.pessoas.length ? recon.pessoas.map(p => `
    <li><span class="p-nome">${esc(p.nome)}</span><span class="p-meta mono">${p.descs.length} amostra${p.descs.length > 1 ? "s" : ""} · ${new Date(p.consentEm).toLocaleDateString("pt-BR")}</span>
      <button class="btn-limpar" data-acao="amostra" data-id="${p.id}" title="Adicionar mais uma amostra do rosto (outro ângulo/luz)">+ amostra</button>
      <button class="btn-limpar" data-acao="apagar" data-id="${p.id}">apagar</button></li>`).join("")
    : `<li class="vazio">ninguém cadastrado</li>`;
  const sel = $("sel-cad-cam");
  sel.innerHTML = cams.map((c, i) => `<option value="${i}">${esc(c.nome)}</option>`).join("");
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
    tr.box = d.box; tr.visto = agora; tr.regioes = d.regioes; tr.ancora = d.ancora; tr.rostoBox = d.rosto || tr.rostoBox;
    tr.score = 0.8 * tr.score + 0.2 * d.score;
    tr.hist.push(d.epi); if (tr.hist.length > 8) tr.hist.shift();
  }
  for (const d of livres) {
    cam.tracks.push({
      id: cam.proximoId++, box: d.box, kps: [], score: d.score, inicio: agora, visto: agora,
      hist: [d.epi], regioes: d.regioes, ancora: d.ancora, rostoBox: d.rosto || null, faltando: [], semEpiDesde: null, avisado: false,
      ghost: false, sumido: 0, focoS: 0, totalS: 0, semEpiS: 0, ultimoTick: agora,
    });
  }
  cam.tracks = cam.tracks.filter(tr => agora - tr.visto <= 2.0); // folga pro rodízio de câmeras
}
function posicaoNaSala(cam, alvo) { return fileirasECadeiras(cam.tracks).get(alvo) || null; }
/** Nome curto da pessoa/lugar: pessoa reconhecida > posto mapeado > fileira/cadeira estimada > #id. */
function nomeCurto(cam, tr) {
  if (tr.pessoa) return tr.pessoa;
  const p = cam.postoDe(tr);
  if (p) return p.nome;
  const pos = posicaoNaSala(cam, tr);
  return pos ? (modo === "seguranca" ? `P${pos[1]}` : `F${pos[0]}·C${pos[1]}`) : `#${tr.id}`;
}
function ondeFica(cam, tr) {
  const p = tr.pessoa ? null : cam.postoDe(tr);
  const pos = tr.pessoa || p ? null : posicaoNaSala(cam, tr);
  const lugar = tr.pessoa ? tr.pessoa : p ? p.nome : !pos ? "Alguém"
    : modo === "seguranca" ? `Posição ${pos[1]} da esquerda${pos[0] > 1 ? `, fila ${pos[0]}` : ""}`
    : `Fileira ${pos[0]}, cadeira ${pos[1]} contando da sua esquerda`;
  return cams.length > 1 ? `${cam.nome}: ${lugar}` : lugar;
}

// ------------------------------------------------------------------ regras por modo (por câmera)
function avaliar(cam, agora) {
  const T = segundosDoModo();
  const m = MODOS[modo];
  let bons = 0, ruins = 0;
  const posicoes = m.usaAlerta ? fileirasECadeiras(cam.tracks.filter(t => valido(t) && !t.ghost)) : null;
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
    const pos = posicoes?.get(tr); if (pos) acumularHeat(cam.heat, pos, dt, flag); // mapa de calor da sessão

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
  const posicoes = fileirasECadeiras(cam.tracks.filter(valido));
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
    const pos = posicoes.get(tr); if (pos) acumularHeat(cam.heat, pos, dt, !est.conforme);
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
  // postos mapeados (retângulos finos com nome) + retângulo em desenho no modo de edição
  if (cam.postos.length || cam.edicao) {
    ctx.save(); ctx.lineWidth = Math.max(1, W / 900); ctx.strokeStyle = "rgba(62,224,255,.75)"; ctx.setLineDash([8, 6]);
    for (const p of cam.postos) {
      const [x, y, w, h] = p.box; ctx.strokeRect(x * W, y * H, w * W, h * H);
      ctx.fillStyle = "rgba(7,12,18,.7)"; const tw = ctx.measureText(p.nome).width + 10;
      ctx.fillRect(x * W, y * H, tw, Math.max(16, W / 60)); ctx.fillStyle = "#3ee0ff"; ctx.fillText(p.nome, x * W + 5, y * H + Math.max(12, W / 80));
    }
    if (cam.rascunho) { const [x1, y1, x2, y2] = cam.rascunho; ctx.setLineDash([]); ctx.strokeStyle = "#fff"; ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); }
    ctx.restore();
  }
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
    const etiqueta = [tr.pessoa, tr.rotulo].filter(Boolean).join(" · ");
    if (etiqueta && !suspeito) { ctx.fillStyle = cor; ctx.fillText(etiqueta, x, Math.max(16, y - 6)); }
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
    this.tracks = []; this.proximoId = 1; this.tileCursor = 0; this.heat = new Map();
    this.rodando = false; this.stream = null; this.fps = 0; this.lastFaces = 0; this.res = ""; this.erro = null;
    this.bons = 0; this.ruins = 0;
    this.edicao = false; this.rascunho = null; // mapa de postos
    this.montar();
    this.carregarPostos();
  }
  chave() { return this.deviceId || `cam:${this.nome}`; }
  carregarPostos() { this.postos = cfg.postos[this.chave()] || []; }
  salvarPostos() { cfg.postos[this.chave()] = this.postos; salvarCfg(); this.renderPostosUi(); }
  postoDe(tr) { return this.postos.length && this.video.videoWidth ? postoDe(tr.box, this.postos, this.video.videoWidth, this.video.videoHeight) : null; }
  renderPostosUi() {
    this.el.querySelector(".cell-postos").classList.toggle("ativo", this.edicao);
    this.el.classList.toggle("editando", this.edicao);
    this.el.querySelector(".cell-postos").textContent = this.edicao ? "pronto" : (this.postos.length ? `postos (${this.postos.length})` : "postos");
    this.msgPostos.hidden = !this.edicao;
    if (!this.rodando) desenhar(this);
  }
  pontoDoEvento(e) {
    const r = this.canvas.getBoundingClientRect();
    const W = this.video.videoWidth || this.canvas.width, H = this.video.videoHeight || this.canvas.height;
    let x = (e.clientX - r.left) / r.width * W; const y = (e.clientY - r.top) / r.height * H;
    if (cfg.espelho) x = W - x;
    return [x, y];
  }
  ligarEdicaoPostos() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      if (!this.edicao || !this.video.videoWidth) return;
      const [x, y] = this.pontoDoEvento(e);
      this.rascunho = [x, y, x, y]; c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.edicao || !this.rascunho) return;
      const [x, y] = this.pontoDoEvento(e); this.rascunho[2] = x; this.rascunho[3] = y;
      if (!this.rodando) desenhar(this);
    });
    c.addEventListener("pointerup", () => {
      if (!this.edicao || !this.rascunho) return;
      const [x1, y1, x2, y2] = this.rascunho; this.rascunho = null;
      const W = this.video.videoWidth, H = this.video.videoHeight;
      const box = normalizarRect(x1, y1, x2, y2, W, H);
      if (!box) { // clique simples: em cima de um posto = remover
        const alvo = postoDe([x1, y1, 0, 0], this.postos, W, H);
        if (alvo && confirm(`Remover o posto "${alvo.nome}"?`)) { this.postos = this.postos.filter(p => p !== alvo); this.salvarPostos(); registrarLog(`${this.nome}: posto "${alvo.nome}" removido`); }
        return;
      }
      const nome = (prompt("Nome deste posto/assento (ex.: Posto 3, Mesa da Ana):", `Posto ${this.postos.length + 1}`) || "").trim();
      if (!nome) return;
      this.postos = [...this.postos, { id: Math.random().toString(36).slice(2, 8), nome, box }];
      this.salvarPostos(); registrarLog(`${this.nome}: posto "${nome}" mapeado`);
    });
  }
  montar() {
    this.el = document.createElement("div");
    this.el.className = "cell";
    this.el.innerHTML = `
      <div class="cell-top">
        <input class="cell-nome" value="${esc(this.nome)}" title="Nome do ambiente (clique pra editar)">
        <select class="cell-dev" title="Qual câmera alimenta esta célula"><option value="">câmera padrão</option></select>
        <span class="cell-meta mono">—</span>
        <button class="cell-postos" title="Mapear postos/assentos: arraste um retângulo sobre cada lugar e dê um nome">postos</button>
        <button class="cell-x" title="Remover câmera">×</button>
      </div>
      <div class="cell-video"><video playsinline muted></video><canvas></canvas><div class="cell-msg" hidden></div>
        <div class="cell-postos-msg" hidden>Arraste um retângulo sobre cada posto/assento e dê um nome. Clique num posto pra remover. <b>pronto</b> fecha.</div></div>`;
    this.video = this.el.querySelector("video");
    this.canvas = this.el.querySelector("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.meta = this.el.querySelector(".cell-meta");
    this.msg = this.el.querySelector(".cell-msg");
    this.msgPostos = this.el.querySelector(".cell-postos-msg");
    this.sel = this.el.querySelector(".cell-dev");
    this.el.querySelector(".cell-nome").addEventListener("input", (e) => { this.nome = e.target.value.trim() || this.nome; salvarCfg(); if (!this.deviceId) { this.carregarPostos(); this.renderPostosUi(); } });
    this.sel.addEventListener("change", async () => {
      this.deviceId = this.sel.value || null; salvarCfg(); this.carregarPostos(); this.renderPostosUi();
      if (this.rodando) { this.parar(); await this.ligar(); }
    });
    this.el.querySelector(".cell-x").addEventListener("click", () => removerCam(this));
    this.el.querySelector(".cell-postos").addEventListener("click", () => {
      if (!this.rodando) { registrarLog(`${this.nome}: ligue as câmeras antes de mapear postos (precisa ver a imagem)`); return; }
      this.edicao = !this.edicao; this.rascunho = null; this.renderPostosUi();
    });
    this.ligarEdicaoPostos();
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
    this.rodando = false; this.edicao = false; this.rascunho = null; this.renderPostosUi();
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
    reconhecer(this, agora);
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
      const nome = (cams.length > 1 ? esc(cam.nome) + " " : "") + esc(nomeCurto(cam, t));
      return `<div class="stat-linha ${pct < 0.6 ? "ruim" : ""}"><span>${nome}</span>
        <span class="barra"><i style="width:${Math.round(pct * 100)}%"></i></span><span>${Math.round(pct * 100)}%</span></div>`;
    }).join("") : `<p class="dica">acumulando… aparece após 10s de cada pessoa</p>`;
  } else if (modo === "seguranca") {
    painel.hidden = false; $("stats-titulo").textContent = "EPI por pessoa (% do tempo em conformidade)";
    const linhas = cams.flatMap(cam => cam.tracks.filter(t => t.totalS > 5).map(t => ({ cam, t, pct: 1 - t.semEpiS / t.totalS })))
      .sort((a, b) => a.pct - b.pct).slice(0, 14);
    corpo.innerHTML = linhas.length ? linhas.map(({ cam, t, pct }) => {
      const nome = (cams.length > 1 ? esc(cam.nome) + " " : "") + esc(nomeCurto(cam, t)) + (t.faltando?.length ? ` · ${esc(rotuloEpi(t.faltando).toLowerCase())}` : "");
      return `<div class="stat-linha ${pct < 0.6 ? "ruim" : ""}"><span>${nome}</span>
        <span class="barra"><i style="width:${Math.round(pct * 100)}%"></i></span><span>${Math.round(pct * 100)}%</span></div>`;
    }).join("") : `<p class="dica">acumulando… aparece após 5s de cada pessoa</p>`;
  } else if (modo === "presenca") {
    painel.hidden = false; $("stats-titulo").textContent = cams.length > 1 ? "Evolução (todas as câmeras)" : "Evolução da sala";
    if (!$("spark")) corpo.innerHTML = `<canvas id="spark" class="curva"></canvas>`;
    desenharCurva($("spark"), amostrasPresenca.map(a => a[1]), Math.max(picoPresenca, 1));
  } else painel.hidden = true;
}
function desenharCurva(c, valores, max, cor = "#3ee0ff", marcas = []) {
  if (!c) return;
  const w = c.width = c.clientWidth || 300, h = c.height = 64;
  const g = c.getContext("2d");
  g.clearRect(0, 0, w, h);
  if (valores.length < 2) return;
  const xy = (i) => [(i / (valores.length - 1)) * (w - 4) + 2, h - 4 - (valores[i] / max) * (h - 10)];
  g.beginPath();
  valores.forEach((n, i) => { const [x, y] = xy(i); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.strokeStyle = cor; g.lineWidth = 2; g.stroke();
  for (const i of marcas) { // pontos de queda
    if (i < 0 || i >= valores.length) continue;
    const [x, y] = xy(i);
    g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fillStyle = CORES.flag; g.fill();
  }
}
function renderHeatmap() {
  const el = $("heat");
  const m = MODOS[modo];
  if (!m.usaAlerta) { el.innerHTML = ""; return; }
  const blocos = cams.map(cam => ({ cam, g: gradeHeatmap(cam.heat) })).filter(b => b.g.fileiras);
  if (!blocos.length) { el.innerHTML = ""; return; }
  const rot = modo === "seguranca" ? "sem EPI" : modo === "postura" ? "parado" : "disperso";
  el.innerHTML = blocos.map(({ cam, g }) => `
    <div class="heat-bloco">
      <div class="heat-cam">${cams.length > 1 ? esc(cam.nome) + " · " : ""}onde o tempo ${rot} se concentra (fileira 1 = frente)</div>
      <div class="heat" style="grid-template-columns: 22px repeat(${g.cadeiras}, 1fr)">
        ${g.celulas.map((linha, fi) => `<div class="heat-f">F${fi + 1}</div>` + linha.map(c => c
          ? `<div class="heat-c" style="background:hsl(${Math.round(120 - 120 * c.pct)},70%,${28 + Math.round(12 * c.pct)}%)" title="${Math.round(c.pct * 100)}% do tempo ${rot} (${formataDur(c.total)})">${Math.round(c.pct * 100)}%</div>`
          : `<div class="heat-c vazia"></div>`).join("")).join("")}
      </div>
    </div>`).join("");
}

// ------------------------------------------------------------------ relatório da sessão
function novaSessao() { return { inicio: agoraS(), inicioWall: Date.now(), passoS: 5, amostras: [], avisos: [], picos: 0 }; }
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
  const quedas = m.taxa ? pontosDeQueda(sessao.amostras) : [];
  const pr = resumoPresenca(sessao.amostras);
  if (m.taxa) itens.push([m.taxa, pct], ["Nota", r.nota.rotulo, r.nota.cor]);
  else itens.push(["Média de pessoas", r.mediaPessoas.toFixed(1)]);
  if (pr.picoT != null) itens.push(["Pico às", horaDe(pr.picoT)]);
  if (modo === "presenca") itens.push(["Entradas", pr.entradas], ["Saídas", pr.saidas]);
  if (m.usaAlerta) itens.push(["Minutos com alerta", r.minutosComAlerta.toFixed(1)], ["Avisos emitidos", r.avisos]);
  if (m.taxa) itens.push(["Quedas de atenção", quedas.length, quedas.length ? "warn" : ""]);
  if (r.ruidoMedio != null) itens.push(["Ruído médio", Math.round(r.ruidoMedio)], ["Gritos / picos", sessao.picos, sessao.picos ? "warn" : ""]);
  $("rel-grid").innerHTML = itens.map(([k, v, cor]) =>
    `<div class="rel-item ${cor || ""}"><span class="rel-v">${esc(v)}</span><span class="rel-k">${esc(k)}</span></div>`).join("");
  const serie = sessao.amostras.map(a => a.ok + a.alerta ? 100 * a.ok / (a.ok + a.alerta) : (a.pessoas ? 100 : 0));
  desenharCurva($("curva"), m.taxa ? serie : sessao.amostras.map(a => a.pessoas), m.taxa ? 100 : Math.max(r.pico, 1), "#34e08c", quedas.map(q => q.i));
  $("curva-legenda").hidden = !quedas.length;
  renderHeatmap();
  $("btn-csv").disabled = !sessao.amostras.length; $("btn-print").disabled = !sessao.amostras.length;
}
// ------------------------------------------------------------------ histórico de sessões (IndexedDB) e relatório imprimível
let sessaoAntigaFim = null; // quando uma sessão do histórico está aberta no painel, o "agora" do relatório é o fim dela
async function guardarSessao() {
  if (sessao.amostras.length < 2) return;
  try { await salvarSessao(compactarSessao(sessao, modo, cams)); await renderHistorico(); }
  catch (e) { erros.push("histórico: " + e.message); registrarLog("não consegui guardar a sessão no histórico: " + e.message); }
}
async function renderHistorico() {
  const ul = $("lista-sessoes");
  try {
    const regs = await listarSessoes();
    ul.innerHTML = regs.length ? regs.slice(0, 30).map(reg => {
      const r = resumoSessao({ inicio: reg.inicio, passoS: reg.passoS, amostras: reg.amostras, avisos: reg.avisos }, reg.fimT);
      const d = new Date(reg.inicioWall);
      return `<li data-id="${reg.id}"><span class="s-quando mono">${d.toLocaleDateString("pt-BR")} ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
        <span class="s-meta">${esc(MODOS[reg.modo]?.nome || reg.modo)} · ${formataDur(r.duracaoS)} · pico ${r.pico}${MODOS[reg.modo]?.taxa ? ` · ${r.nota.rotulo}` : ""}</span>
        <button class="btn-limpar" data-acao="abrir">abrir</button><button class="btn-limpar" data-acao="apagar">apagar</button></li>`;
    }).join("") : `<li class="vazio">nenhuma sessão guardada ainda (aparece ao parar as câmeras)</li>`;
  } catch (e) { ul.innerHTML = `<li class="vazio">histórico indisponível neste navegador (${esc(e.message)})</li>`; }
}
async function abrirSessaoAntiga(id) {
  if (rodando) { registrarLog("pare as câmeras antes de abrir uma sessão antiga"); return false; }
  const reg = (await listarSessoes()).find(r => r.id === id); if (!reg) return false;
  if (reg.modo in MODOS) { modo = reg.modo; }
  sessao = { inicio: reg.inicio, inicioWall: reg.inicioWall, passoS: reg.passoS, amostras: reg.amostras, avisos: reg.avisos, picos: reg.picos || 0 };
  cams.forEach((c, i) => c.heat = expandirHeat(reg.heat?.[i]?.celulas));
  sessaoAntigaFim = reg.fimT;
  aplicarUi();
  registrarLog(`sessão de ${new Date(reg.inicioWall).toLocaleString("pt-BR")} aberta no painel (relatório, CSV e impressão)`);
  return true;
}
function imprimirRelatorio() {
  const m = MODOS[modo];
  const d = new Date(sessao.inicioWall);
  const el = $("print-rel");
  const curva = $("curva");
  el.innerHTML = `
    <h1>Radar da Plateia — relatório da sessão</h1>
    <p class="print-meta">Modo ${esc(m.nome)} · ${d.toLocaleDateString("pt-BR")} às ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} · ${cams.map(c => esc(c.nome)).join(", ")}</p>
    <div class="print-grid">${$("rel-grid").innerHTML}</div>
    ${curva?.width ? `<img class="print-curva" src="${curva.toDataURL("image/png")}" alt="curva da sessão">` : ""}
    ${$("heat").innerHTML ? `<div class="print-heat">${$("heat").innerHTML}</div>` : ""}
    <h2>Avisos (${sessao.avisos.length})</h2>
    <ol>${sessao.avisos.map(v => `<li><span class="mono">${horaDe(v.t)}</span> ${esc(v.texto)}</li>`).join("") || "<li>nenhum</li>"}</ol>
    <p class="print-rodape">Gerado pelo Radar da Plateia · Expert Integrado · processamento 100% local, nenhuma imagem é guardada.</p>`;
  window.print();
}
// alerta coletivo: a sala inteira caiu (não é sobre uma pessoa) — 1 aviso por episódio
let salaAvisada = false;
function avaliarSala(agora) {
  const m = MODOS[modo];
  if (!m.taxa || !cfg.salaPct) return;
  const s = alertaSala(sessao.amostras, agora, { limiar: cfg.salaPct, duracaoS: 30 });
  if (s.ativo && !salaAvisada && totalPessoas() >= 2) {
    const oque = modo === "atencao" ? "olhando pra frente" : modo === "exercicio" ? "no exercício" : modo === "seguranca" ? "com EPI" : "em dia";
    if (emitirAviso(`Atenção: a sala caiu. Só ${Math.round(s.taxa)} por cento ${oque} há ${Math.round(agora - s.desde)} segundos.`)) salaAvisada = true;
  }
  if (salaAvisada && (!s.ativo && s.taxa != null && s.taxa >= cfg.salaPct + 10)) salaAvisada = false;
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
    renderStats(); renderTelao();
    amostrarSessao(agora, bons, ruins);
    if (agora - ultimoRender >= 2) { ultimoRender = agora; renderRelatorio(agora); avaliarSala(agora); }
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
      $("feed-vazio").hidden = true; $("btn-fs").hidden = false; $("btn-telao").hidden = false; $("btn-parar").hidden = false;
      setPill("pill-camera", "on");
      $("pill-camera").lastChild.textContent = ok > 1 ? `${ok} CÂMERAS` : `CÂMERA ${cams[0].res}`;
      rodando = true; custoTick = []; amostrasPresenca = []; picoPresenca = 0;
      sessao = novaSessao(); ultimoRender = 0; salaAvisada = false; sessaoAntigaFim = null; cams.forEach(c => c.heat = new Map());
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
  sairDoTelao();
  renderRelatorio(agoraS());
  guardarSessao();
  $("feed-vazio").hidden = false;
  $("feed-msg").innerHTML = "Câmeras paradas. O relatório da sessão está no painel ao lado. Clique em <strong>Ligar câmeras</strong> pra começar outra.";
  $("btn-parar").hidden = true; $("btn-fs").hidden = true; $("btn-telao").hidden = true;
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
  $("inp-sala").value = cfg.salaPct; $("lbl-sala").textContent = cfg.salaPct ? `abaixo de ${cfg.salaPct}%` : "desligado";
  $("campo-sala").hidden = !MODOS[modo].taxa;
  $("chk-espelho").checked = cfg.espelho;
  $("chk-ruido").checked = cfg.ruido;
  $("chk-pico").checked = cfg.pico; $("chk-pico").disabled = !cfg.ruido;
  $("chk-facial").checked = cfg.facial; $("chk-consent").checked = cfg.consent; $("facial-corpo").hidden = !cfg.facial;
  renderPessoas();
  $("feeds").classList.toggle("espelhado", cfg.espelho);
  document.querySelectorAll("#seg-aviso button").forEach(b => b.classList.toggle("ativo", b.dataset.v === cfg.aviso));
  $("campo-voz").hidden = cfg.aviso !== "voz"; renderVozes();
  document.querySelectorAll("#seg-alcance button").forEach(b => b.classList.toggle("ativo", b.dataset.v === cfg.alcance));
  $("campo-epi").hidden = modo !== "seguranca";
  $("chk-epi-colete").checked = !!cfg.epi.colete; $("chk-epi-capacete").checked = !!cfg.epi.capacete;
  document.querySelectorAll("#seg-rigor button").forEach(b => b.classList.toggle("ativo", b.dataset.v === cfg.epi.rigor));
  renderContadores(0, 0); renderStats(); renderRelatorio(sessaoAntigaFim ?? agoraS());
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
$("sel-voz").addEventListener("change", () => {
  cfg.voz = $("sel-voz").value; salvarCfg(); acharVozPt();
  falar("Esta é a voz dos avisos.");
});
$("seg-alcance").addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  cfg.alcance = b.dataset.v; cams.forEach(c => c.tileCursor = 0); custoTick = []; salvarCfg(); aplicarUi();
});
$("inp-gap").addEventListener("input", () => { cfg.gap = Number($("inp-gap").value); $("lbl-gap").textContent = cfg.gap + "s"; salvarCfg(); });
$("inp-vol").addEventListener("input", () => { cfg.volume = Number($("inp-vol").value); $("lbl-vol").textContent = cfg.volume + "%"; salvarCfg(); });
$("inp-sala").addEventListener("input", () => { cfg.salaPct = Number($("inp-sala").value); $("lbl-sala").textContent = cfg.salaPct ? `abaixo de ${cfg.salaPct}%` : "desligado"; salaAvisada = false; salvarCfg(); });
$("chk-espelho").addEventListener("change", () => { cfg.espelho = $("chk-espelho").checked; salvarCfg(); aplicarUi(); });
$("chk-ruido").addEventListener("change", async () => {
  cfg.ruido = $("chk-ruido").checked; salvarCfg(); $("chk-pico").disabled = !cfg.ruido;
  if (cfg.ruido && rodando) await ligarRuido();
  if (!cfg.ruido) desligarRuido();
});
$("chk-pico").addEventListener("change", () => { cfg.pico = $("chk-pico").checked; salvarCfg(); });
function aplicarFacial() {
  salvarCfg(); aplicarUi();
  if (facialLigado()) garantirFaceApi();
  else cams.forEach(c => c.tracks.forEach(t => { t.pessoa = null; t.votos = []; }));
}
$("chk-facial").addEventListener("change", () => { cfg.facial = $("chk-facial").checked; aplicarFacial(); });
$("chk-consent").addEventListener("change", () => { cfg.consent = $("chk-consent").checked; aplicarFacial(); if (cfg.facial && !cfg.consent) registrarLog("reconhecimento facial desligado: sem consentimento confirmado"); });
$("btn-cadastrar").addEventListener("click", async () => {
  const b = $("btn-cadastrar"); b.disabled = true;
  const r = await cadastrarRosto(Number($("sel-cad-cam").value), $("inp-cad-nome").value);
  b.disabled = false;
  if (r.ok) $("inp-cad-nome").value = ""; else registrarLog("cadastro de rosto: " + r.motivo);
});
$("lista-pessoas").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-acao]"); if (!b) return;
  const p = recon.pessoas.find(x => x.id === b.dataset.id); if (!p) return;
  if (b.dataset.acao === "apagar") { if (confirm(`Apagar o cadastro de ${p.nome}? (imediato, sem volta)`)) { recon.pessoas = recon.pessoas.filter(x => x !== p); salvarPessoas(); registrarLog(`cadastro apagado: ${p.nome}`); } }
  else { const r = await cadastrarRosto(Number($("sel-cad-cam").value), p.nome, p.id); if (!r.ok) registrarLog("amostra: " + r.motivo); }
});
$("btn-ligar").addEventListener("click", ligarTudo);
$("btn-parar").addEventListener("click", pararTudo);
$("btn-add-cam").addEventListener("click", () => adicionarCam({ nome: `Câmera ${cams.length + 1}` }));
$("btn-csv").addEventListener("click", baixarCsv);
$("btn-fs").addEventListener("click", () => { document.fullscreenElement ? document.exitFullscreen() : feedWrap.requestFullscreen(); });
// ------------------------------------------------------------------ modo telão: só números, sem mostrar a câmera (pra projetar)
function renderTelao() {
  if (!document.body.classList.contains("telao")) return;
  const m = MODOS[modo];
  const r = resumoSessao(sessao, agoraS());
  const nums = [...document.querySelectorAll("#contadores .contador")].map(c => `<div class="t-num ${c.className.replace("contador", "").trim()}"><b>${c.querySelector(".num").textContent}</b><span>${c.querySelector(".rot").textContent}</span></div>`).join("");
  $("telao").innerHTML = `<div class="t-topo">Modo ${esc(m.nome)} · ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</div>
    <div class="t-nums">${nums}</div>
    ${m.taxa ? `<div class="t-nota ${r.nota.cor}">${r.taxa == null ? "—" : Math.round(r.taxa * 100) + "%"} <small>${esc(m.taxa)} · nota ${esc(r.nota.rotulo)}</small></div>` : ""}
    <div class="t-rodape">${formataDur(r.duracaoS)} de sessão · ${totalPessoas()} pessoa${totalPessoas() === 1 ? "" : "s"} agora</div>`;
}
function entrarNoTelao() {
  document.body.classList.add("telao"); $("telao").hidden = false; renderTelao();
  if (!document.fullscreenElement) feedWrap.requestFullscreen?.().catch(() => {});
}
function sairDoTelao() {
  document.body.classList.remove("telao"); $("telao").hidden = true;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
$("btn-telao").addEventListener("click", () => document.body.classList.contains("telao") ? sairDoTelao() : entrarNoTelao());
$("telao").addEventListener("dblclick", sairDoTelao);
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && document.body.classList.contains("telao")) sairDoTelao(); });
$("btn-print").addEventListener("click", imprimirRelatorio);
$("lista-sessoes").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-acao]"); if (!b) return;
  const id = Number(b.closest("li").dataset.id);
  if (b.dataset.acao === "abrir") await abrirSessaoAntiga(id);
  else if (confirm("Apagar esta sessão do histórico?")) { await apagarSessao(id); await renderHistorico(); }
});
$("btn-limpar").addEventListener("click", () => { $("log").innerHTML = `<li class="vazio">nenhum aviso ainda</li>`; });

// debug / teste automatizado
window.__radar = {
  get estado() {
    return {
      build: BUILD, rodando, modo, engineOk: !!detector, pessoasOk: !!detectorPessoas, erros: [...erros],
      sessao: { amostras: sessao.amostras.length, avisos: sessao.avisos.length, ultimoAviso: sessao.avisos[sessao.avisos.length - 1]?.texto ?? null },
      ruido: ruido.ativo ? ruido.nivel : null,
      epi: { ...cfg.epi, segundos: segundosDoModo() },
      facial: { ligado: facialLigado(), pronto: recon.pronto, erro: recon.erro, pessoas: recon.pessoas.map(p => ({ nome: p.nome, amostras: p.descs.length })) },
      cams: cams.map(c => ({ nome: c.nome, rodando: c.rodando, res: c.res, lastFaces: c.lastFaces,
                             tracks: c.tracks.length, validos: c.tracks.filter(valido).length,
                             pessoas: c.tracks.map(t => ({ id: t.id, estado: t.estado ?? null, faltando: t.faltando ?? null, hist: t.hist?.length ?? 0, ancora: t.ancora ?? null, pessoa: t.pessoa ?? null, votos: t.votos ?? [],
                                                            box: t.box.map(v => Math.round(v)), score: +t.score.toFixed(2), ghost: !!t.ghost, idadeS: +(agoraS() - t.inicio).toFixed(1) })),
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
  setPostos: (i, postos) => { const c = cams[i]; if (!c) return false; c.postos = postos; c.salvarPostos(); return true; },
  setFacial: (on) => { cfg.facial = !!on; cfg.consent = !!on; aplicarFacial(); return facialLigado(); },
  cadastrarRosto: (i, nome) => cadastrarRosto(i, nome),
  pessoas: () => recon.pessoas.map(p => p.nome),
  apagarPessoas: () => { recon.pessoas = []; salvarPessoas(); },
  historico: () => listarSessoes().then(rs => rs.map(r => ({ id: r.id, modo: r.modo, amostras: r.amostras.length, avisos: r.avisos.length }))),
  abrirSessao: (id) => abrirSessaoAntiga(id),
  telao: (on) => { on ? entrarNoTelao() : sairDoTelao(); return document.body.classList.contains("telao"); },
  relatorioHtml: () => $("rel-grid").innerText,
  getPostos: (i) => cams[i]?.postos ?? null,
  nomes: (i) => (cams[i]?.tracks ?? []).map(t => nomeCurto(cams[i], t)),
};

// boot
$("build").textContent = BUILD;
cfg.cams.forEach(spec => adicionarCam(spec));
if ("speechSynthesis" in window) acharVozPt();
aplicarUi();
renderHistorico();
