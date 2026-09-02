import { test } from "node:test";
import assert from "node:assert/strict";
import {
  iou, contencao, dedupe, geometria, mediana, formataDur, zonas,
  fileirasECadeiras, classificarNota, resumoSessao, csvRelatorio, valido, SCORE_MIN,
  RIGOR_EPI, rgb2hsv, altaVisibilidade, analisarCores, regioesEpi, regioesEpiPorRosto, rostoDaPessoa, amostraEpi, estadoEpi,
  rotuloEpi, fraseEpi, casarPorIou, detectarPico,
  taxaDaAmostra, pontosDeQueda, alertaSala, acumularHeat, gradeHeatmap, postoDe, normalizarRect,
} from "../engine.js";

// pixels RGBA repetidos n vezes
const pixels = (...blocos) => {
  const out = [];
  for (const [rgb, n] of blocos) for (let i = 0; i < n; i++) out.push(rgb[0], rgb[1], rgb[2], 255);
  return new Uint8ClampedArray(out);
};
const AMARELO_HV = [204, 255, 0], LARANJA_HV = [255, 103, 0], MARINHO = [20, 30, 90], BRANCO = [250, 250, 250],
      PELE = [224, 172, 140], PELE_SOMBRA = [170, 100, 60], GRAMA = [60, 160, 60];

test("iou: caixas iguais = 1, separadas = 0, metade sobreposta ≈ 1/3", () => {
  assert.equal(iou([0, 0, 10, 10], [0, 0, 10, 10]), 1);
  assert.equal(iou([0, 0, 10, 10], [20, 20, 5, 5]), 0);
  assert.ok(Math.abs(iou([0, 0, 10, 10], [5, 0, 10, 10]) - 1 / 3) < 1e-9);
});

test("contencao: caixa pequena dentro da grande = 1", () => {
  assert.equal(contencao([2, 2, 4, 4], [0, 0, 10, 10]), 1);
  assert.equal(contencao([0, 0, 10, 10], [2, 2, 4, 4]), 0.16);
});

test("dedupe: remove caixa aninhada (mesmo rosto) e mantém rostos distintos, maior score primeiro", () => {
  const dets = [
    { box: [100, 100, 80, 80], score: 0.9 },
    { box: [120, 110, 40, 40], score: 0.5 },   // aninhada -> some
    { box: [400, 100, 80, 80], score: 0.7 },   // outro rosto -> fica
    { box: [410, 105, 80, 80], score: 0.6 },   // sobreposta alta -> some
  ];
  const u = dedupe(dets);
  assert.equal(u.length, 2);
  assert.equal(u[0].score, 0.9);
  assert.equal(u[1].score, 0.7);
});

test("dedupe por área: caixa inteira da pessoa vence a parcial (cortada pela zona) mesmo com score menor", () => {
  const inteira = { box: [100, 50, 200, 500], score: 0.45 };   // cabeça aos pés
  const parcial = { box: [105, 200, 195, 350], score: 0.70 };  // do pescoço pra baixo (zona cortou)
  const outra = { box: [600, 60, 180, 480], score: 0.5 };
  const porScore = dedupe([inteira, parcial, outra]);
  assert.ok(porScore.includes(parcial) && !porScore.includes(inteira), "por score a parcial venceria");
  const porArea = dedupe([inteira, parcial, outra], "area");
  assert.equal(porArea.length, 2);
  assert.ok(porArea.includes(inteira) && porArea.includes(outra) && !porArea.includes(parcial));
});

test("geometria: rosto de frente tem pitch positivo e yaw ~0; virado pro lado desloca o yaw", () => {
  const frente = geometria([[100, 100], [140, 100], [120, 125]]);
  assert.ok(frente.pitch > 0.5 && frente.pitch < 0.7);
  assert.ok(Math.abs(frente.yaw) < 0.01);
  const lado = geometria([[100, 100], [140, 100], [145, 125]]);
  assert.ok(lado.yaw > 0.5);
  const baixa = geometria([[100, 100], [140, 100], [120, 104]]);
  assert.ok(baixa.pitch < frente.pitch);
  assert.equal(geometria([[0, 0], [2, 0], [1, 1]]), null, "olhos colados = sem geometria");
  assert.equal(geometria([]), null);
});

test("mediana e formataDur", () => {
  assert.equal(mediana([5, 1, 3]), 3);
  assert.equal(mediana([4, 1, 3, 2]), 3);
  assert.equal(formataDur(45), "45 segundos");
  assert.equal(formataDur(300), "5 minutos");
  assert.equal(formataDur(119), "119 segundos");
});

test("zonas: perto 0, médio 4, longe 9, todas dentro do quadro", () => {
  assert.equal(zonas(1280, 720, "perto").length, 0);
  assert.equal(zonas(1280, 720, "medio").length, 4);
  const z = zonas(1920, 1080, "longe");
  assert.equal(z.length, 9);
  for (const [x, y, w, h] of z) {
    assert.ok(x >= 0 && y >= 0 && x + w <= 1920 && y + h <= 1080, `zona fora do quadro: ${[x, y, w, h]}`);
  }
});

test("fileirasECadeiras: embaixo é fileira 1, cadeiras da esquerda pra direita", () => {
  const frente1 = { box: [100, 400, 60, 60] }, frente2 = { box: [400, 405, 60, 60] };
  const fundo1 = { box: [250, 150, 40, 40] };
  const mapa = fileirasECadeiras([fundo1, frente2, frente1]);
  assert.deepEqual(mapa.get(frente1), [1, 1]);
  assert.deepEqual(mapa.get(frente2), [1, 2]);
  assert.deepEqual(mapa.get(fundo1), [2, 1]);
  assert.equal(fileirasECadeiras([]).size, 0);
});

test("classificarNota e valido", () => {
  assert.equal(classificarNota(0.9).rotulo, "ótima");
  assert.equal(classificarNota(0.75).rotulo, "boa");
  assert.equal(classificarNota(0.55).rotulo, "regular");
  assert.equal(classificarNota(0.2).rotulo, "fraca");
  assert.equal(classificarNota(null).rotulo, "sem dados");
  assert.equal(valido({ score: SCORE_MIN }), true);
  assert.equal(valido({ score: 0.1 }), false);
  assert.equal(valido({}), false);
});

test("resumoSessao: taxa, pico, minutos com alerta", () => {
  const sessao = {
    inicio: 0, passoS: 5,
    amostras: [
      { t: 5, pessoas: 10, ok: 9, alerta: 1, ruido: 40 },
      { t: 10, pessoas: 12, ok: 12, alerta: 0, ruido: 60 },
      { t: 15, pessoas: 11, ok: 6, alerta: 5, ruido: null },
    ],
    avisos: [{ t: 15, texto: "x" }],
  };
  const r = resumoSessao(sessao, 20);
  assert.equal(r.duracaoS, 20);
  assert.equal(r.pico, 12);
  assert.ok(Math.abs(r.taxa - 27 / 33) < 1e-9);
  assert.ok(Math.abs(r.minutosComAlerta - 10 / 60) < 1e-9);
  assert.equal(r.avisos, 1);
  assert.equal(r.ruidoMedio, 50);
  assert.equal(r.nota.rotulo, "boa");
});

test("csvRelatorio: BOM, ponto-e-vírgula, uma linha por amostra e por aviso, aspas escapadas", () => {
  const sessao = { inicio: 0, passoS: 5, amostras: [{ t: 5, pessoas: 2, ok: 1, alerta: 1, ruido: null }],
                   avisos: [{ t: 7, texto: 'Sala "A": cabeça baixa' }] };
  const csv = csvRelatorio(sessao, "atencao", (t) => `T${t}`);
  assert.ok(csv.startsWith("﻿hora;tipo;modo"));
  const linhas = csv.trim().split("\r\n");
  assert.equal(linhas.length, 3);
  assert.ok(linhas[1].includes('"amostra";"atencao";"2";"1";"1";"50"'));
  assert.ok(linhas[2].includes('""A""'));
});

// ------------------------------------------------------------------ Modo Segurança (EPI)

test("rgb2hsv: vermelho, amarelo alta visibilidade, branco e preto", () => {
  assert.deepEqual(rgb2hsv(255, 0, 0), [0, 1, 1]);
  const [h, s, v] = rgb2hsv(...AMARELO_HV);
  assert.ok(h > 65 && h < 80, `matiz do amarelo fluorescente ${h}`);
  assert.equal(s, 1); assert.equal(v, 1);
  assert.equal(rgb2hsv(255, 255, 255)[1], 0);
  assert.deepEqual(rgb2hsv(0, 0, 0), [0, 0, 0]);
});

test("altaVisibilidade: amarelo e laranja fluorescentes sim; marinho, pele, grama e branco não", () => {
  assert.equal(altaVisibilidade(...rgb2hsv(...AMARELO_HV)), true);
  assert.equal(altaVisibilidade(...rgb2hsv(...LARANJA_HV)), true);
  assert.equal(altaVisibilidade(...rgb2hsv(...MARINHO)), false);
  assert.equal(altaVisibilidade(...rgb2hsv(...PELE)), false, "pele é laranja pouco saturado");
  assert.equal(altaVisibilidade(...rgb2hsv(...PELE_SOMBRA)), false, "pele bronzeada/sombreada (s≈0.65) não é colete laranja");
  assert.equal(altaVisibilidade(...rgb2hsv(...GRAMA)), false, "verde de grama não é fluorescente");
  assert.equal(altaVisibilidade(...rgb2hsv(...BRANCO)), false);
});

test("regioesEpiPorRosto: colete abaixo do queixo, capacete acima da testa, dentro da caixa; fora do quadro = indefinido", () => {
  const caixa = [60, 20, 160, 400], rosto = [100, 50, 60, 60];
  const r = regioesEpiPorRosto(caixa, rosto);
  assert.ok(r.colete[1] >= 110, "colete começa abaixo do queixo");
  assert.ok(r.capacete[1] + r.capacete[3] <= 60, "capacete termina na testa");
  assert.equal(r.capacete[1], 20, "recortado ao topo da caixa");
  assert.equal(r.torsoVisivel, true); assert.equal(r.cabecaVisivel, true);
  for (const [x, y, w, h] of [r.colete, r.capacete]) assert.ok(x >= 60 && y >= 20 && x + w <= 220 + 1e-9 && y + h <= 420 + 1e-9 && w > 0 && h > 0);
  const pe = regioesEpiPorRosto(caixa, [100, 380, 60, 60]);
  assert.equal(pe.torsoVisivel, false, "rosto no pé da caixa: torso não cabe -> sem leitura de colete");
  assert.ok(pe.colete[1] + pe.colete[3] <= 420 + 1e-9, "mesmo assim a região fica dentro da caixa");
  const topo = regioesEpiPorRosto(caixa, [100, 20, 60, 60]);
  assert.equal(topo.cabecaVisivel, false, "rosto colado no topo: não dá pra ver o capacete");
  assert.equal(topo.torsoVisivel, true);
});

test("rostoDaPessoa: rosto com centro na metade de cima da caixa; maior vence; fora = null", () => {
  const caixa = [0, 0, 200, 600];
  const pequeno = { box: [80, 40, 30, 30] }, grande = { box: [60, 60, 80, 80] }, embaixo = { box: [80, 500, 40, 40] }, fora = { box: [400, 40, 50, 50] };
  assert.deepEqual(rostoDaPessoa(caixa, [pequeno, grande, embaixo, fora]), grande.box);
  assert.equal(rostoDaPessoa(caixa, [embaixo, fora]), null);
  assert.deepEqual(rostoDaPessoa(caixa, [[10, 10, 20, 20]]), [10, 10, 20, 20], "aceita caixa nua");
});

test("analisarCores: frações por região, passo de amostragem e região vazia", () => {
  const colete = analisarCores(pixels([AMARELO_HV, 50], [MARINHO, 50]), 1);
  assert.equal(colete.n, 100);
  assert.ok(Math.abs(colete.colete - 0.5) < 1e-9);
  const branco = analisarCores(pixels([BRANCO, 40]), 1);
  assert.equal(branco.capaceteBranco, 1); assert.equal(branco.colete, 0); assert.equal(branco.capaceteCor, 0);
  const laranja = analisarCores(pixels([LARANJA_HV, 40]), 1);
  assert.equal(laranja.capaceteCor, 1, "capacete laranja é cor saturada");
  assert.equal(analisarCores(pixels([MARINHO, 40]), 2).n, 20, "passo 2 amostra metade");
  assert.deepEqual(analisarCores(new Uint8ClampedArray(0)), { n: 0, colete: 0, capaceteCor: 0, capaceteBranco: 0 });
});

test("regioesEpi: meio corpo x corpo inteiro, regiões sempre dentro da caixa", () => {
  const meio = regioesEpi([100, 200, 100, 120]);
  assert.deepEqual(meio.colete.map(Math.round), [118, 234, 64, 41]);
  const inteiro = regioesEpi([0, 0, 100, 300]);
  assert.ok(inteiro.colete[1] < meio.colete[1] + 200 - 200 + 100, "torso do corpo inteiro fica mais no alto (proporcional)");
  assert.equal(Math.round(inteiro.colete[1]), 42);
  assert.equal(Math.round(inteiro.capacete[3]), 33);
  for (const r of [meio, inteiro]) for (const [x, y, w, h] of Object.values(r)) assert.ok(w > 0 && h > 0 && x >= 0 && y >= 0);
  const dentro = (reg, [bx, by, bw, bh]) => reg[0] >= bx && reg[1] >= by && reg[0] + reg[2] <= bx + bw + 1e-9 && reg[1] + reg[3] <= by + bh + 1e-9;
  assert.ok(dentro(meio.colete, [100, 200, 100, 120]) && dentro(meio.capacete, [100, 200, 100, 120]));
  assert.ok(dentro(inteiro.colete, [0, 0, 100, 300]) && dentro(inteiro.capacete, [0, 0, 100, 300]));
});

test("amostraEpi: limiares por rigor (normal 10% de colete; capacete por cor OU branco)", () => {
  const torsoFraco = { colete: 0.08, capaceteCor: 0, capaceteBranco: 0 };
  const topoBranco = { colete: 0, capaceteCor: 0.05, capaceteBranco: 0.40 };
  assert.equal(amostraEpi({ torso: torsoFraco, topo: topoBranco }, "normal").colete, false);
  assert.equal(amostraEpi({ torso: torsoFraco, topo: topoBranco }, "tolerante").colete, true);
  assert.equal(amostraEpi({ torso: torsoFraco, topo: topoBranco }, "normal").capacete, true);
  assert.equal(amostraEpi({ torso: torsoFraco, topo: topoBranco }, "rigoroso").capacete, false);
  assert.equal(amostraEpi({ torso: torsoFraco, topo: topoBranco }, "inexistente").colete, false, "rigor desconhecido cai no normal");
  assert.equal(RIGOR_EPI.normal.colete, 0.10);
});

test("estadoEpi: ainda lendo com <3 amostras; 2 de 6 positivas = tem; só itens obrigatórios contam", () => {
  const sem = { colete: false, capacete: false }, com = { colete: true, capacete: false };
  assert.deepEqual(estadoEpi([sem, sem], { colete: true }), { conforme: null, faltando: [], indefinidos: [] });
  assert.deepEqual(estadoEpi([sem, sem, sem], { colete: true }), { conforme: false, faltando: ["colete"], indefinidos: [] });
  assert.deepEqual(estadoEpi([sem, sem, sem, com, sem, com], { colete: true }), { conforme: true, faltando: [], indefinidos: [] });
  assert.deepEqual(estadoEpi([sem, sem, sem, com, sem, com], { colete: true, capacete: true }), { conforme: false, faltando: ["capacete"], indefinidos: [] });
  assert.deepEqual(estadoEpi([sem, sem, sem], { colete: true, capacete: true }).faltando, ["colete", "capacete"]);
  assert.deepEqual(estadoEpi([sem, sem, sem], { colete: false, capacete: false }), { conforme: true, faltando: [], indefinidos: [] });
  // janela de 6: um "com" antigo não segura o estado
  const hist = [com, com, sem, sem, sem, sem, sem, sem];
  assert.equal(estadoEpi(hist, { colete: true }).conforme, false);
  // torso fora do quadro (amostra null) = indefinido, nunca "sem colete"
  const foraDoQuadro = { colete: null, capacete: false };
  assert.deepEqual(estadoEpi([foraDoQuadro, foraDoQuadro, foraDoQuadro], { colete: true }), { conforme: null, faltando: [], indefinidos: ["colete"] });
  assert.deepEqual(estadoEpi([foraDoQuadro, foraDoQuadro, foraDoQuadro], { colete: true, capacete: true }), { conforme: false, faltando: ["capacete"], indefinidos: ["colete"] });
  assert.equal(estadoEpi([foraDoQuadro, sem, sem, sem], { colete: true }).conforme, false, "3 leituras válidas bastam mesmo com uma null no meio");
});

test("rotuloEpi e fraseEpi", () => {
  assert.equal(rotuloEpi([]), "");
  assert.equal(rotuloEpi(["colete"]), "SEM COLETE");
  assert.equal(rotuloEpi(["colete", "capacete"]), "SEM COLETE E CAPACETE");
  assert.equal(fraseEpi(["colete", "capacete"]), "colete e capacete");
});

test("pontosDeQueda: marca a 1ª amostra de cada queda >= 20 pontos; sala vazia não conta", () => {
  const am = (t, ok, alerta) => ({ t, ok, alerta, pessoas: ok + alerta });
  const amostras = [am(0, 10, 0), am(5, 9, 1), am(10, 5, 5), am(15, 4, 6), am(20, 9, 1), am(25, 0, 0), am(30, 3, 7)];
  const q = pontosDeQueda(amostras);
  assert.equal(q.length, 2);
  assert.deepEqual(q[0], { i: 2, t: 10, de: 100, para: 50 });
  assert.equal(q[1].i, 6, "depois da sala vazia (null) recomeça a comparação com a amostra 20s");
  assert.equal(taxaDaAmostra(am(0, 0, 0)), null);
  assert.equal(pontosDeQueda([]).length, 0);
  assert.equal(pontosDeQueda(amostras, { queda: 60 }).length, 2, "100->40 e 90->30 são quedas de exatamente 60");
  assert.equal(pontosDeQueda(amostras, { queda: 70 }).length, 0);
});

test("postoDe e normalizarRect: posto pelo centro da caixa, menor posto vence, coordenadas normalizadas", () => {
  const postos = [
    { id: "a", nome: "Posto 1", box: [0, 0, 0.5, 1] },
    { id: "b", nome: "Mesa do João", box: [0.1, 0.1, 0.2, 0.3] }, // dentro do Posto 1, menor
    { id: "c", nome: "Posto 2", box: [0.5, 0, 0.5, 1] },
  ];
  assert.equal(postoDe([180, 180, 40, 40], postos, 1000, 1000).nome, "Mesa do João");
  assert.equal(postoDe([400, 800, 40, 40], postos, 1000, 1000).nome, "Posto 1");
  assert.equal(postoDe([900, 100, 40, 40], postos, 1000, 1000).nome, "Posto 2");
  assert.equal(postoDe([900, 100, 40, 40], [], 1000, 1000), null);
  assert.deepEqual(normalizarRect(300, 200, 100, 100, 1000, 500), [0.1, 0.2, 0.2, 0.2], "arrasto em qualquer direção");
  const r = normalizarRect(-50, -50, 2000, 600, 1000, 500);
  assert.deepEqual(r, [0, 0, 1, 1], "preso ao quadro");
  assert.equal(normalizarRect(100, 100, 101, 101, 1000, 500), null, "arrasto minúsculo não vira posto");
});

test("alertaSala: abaixo do limiar por 30 s contados do fim; volta acima zera", () => {
  const am = (t, ok, alerta) => ({ t, ok, alerta, pessoas: ok + alerta });
  const ruim = [am(0, 8, 2), am(5, 4, 6), am(10, 3, 7), am(15, 4, 6), am(20, 2, 8), am(25, 3, 7), am(30, 4, 6), am(35, 3, 7)];
  const s = alertaSala(ruim, 40);
  assert.equal(s.ativo, true); assert.equal(s.desde, 5); assert.equal(s.taxa, 30);
  assert.equal(alertaSala(ruim, 30).ativo, false, "ainda não deu 30 s");
  assert.equal(alertaSala([...ruim, am(40, 9, 1)], 45).ativo, false, "última amostra boa interrompe a sequência");
  assert.equal(alertaSala([], 10).ativo, false);
  assert.equal(alertaSala(ruim, 40, { limiar: 20 }).ativo, false, "limiar mais baixo: 30% não é alerta");
});

test("acumularHeat e gradeHeatmap: fração do tempo em alerta por fileira/cadeira", () => {
  const heat = new Map();
  acumularHeat(heat, [1, 1], 1, false); acumularHeat(heat, [1, 1], 1, true);
  acumularHeat(heat, [2, 3], 2, true);
  const g = gradeHeatmap(heat);
  assert.equal(g.fileiras, 2); assert.equal(g.cadeiras, 3);
  assert.equal(g.celulas[0][0].pct, 0.5); assert.equal(g.celulas[0][0].total, 2);
  assert.equal(g.celulas[1][2].pct, 1);
  assert.equal(g.celulas[0][1], null); assert.equal(g.celulas[1][0], null);
  assert.deepEqual(gradeHeatmap(new Map()), { fileiras: 0, cadeiras: 0, celulas: [] });
});

test("detectarPico: grito sobre fundo calmo sim; barulho constante, subida lenta e histórico curto não", () => {
  const serie = (niveis, passo = 0.1) => niveis.map((n, i) => ({ t: i * passo, nivel: n }));
  const calmo = Array(25).fill(30);
  const grito = detectarPico(serie([...calmo, 92]), 2.5);
  assert.equal(grito.pico, true); assert.equal(grito.nivel, 92); assert.equal(grito.base, 30);
  assert.equal(detectarPico(serie([...calmo, 55]), 2.5).pico, false, "subiu mas não passou do mínimo");
  assert.equal(detectarPico(serie(Array(26).fill(90)), 2.5).pico, false, "barulho alto constante não é pico");
  const lenta = serie(Array.from({ length: 31 }, (_, i) => 30 + i * 2)); // 30 -> 90 em 3 s
  assert.equal(detectarPico(lenta, 3).pico, false, "subida lenta: a mediana acompanha");
  assert.equal(detectarPico(serie([30, 95]), 0.1).pico, false, "sem histórico não decide");
  assert.equal(detectarPico([], 0).pico, false);
  assert.equal(detectarPico(serie([...calmo, 70]), 2.5, { minimo: 60, salto: 20 }).pico, true, "limiares configuráveis");
});

test("casarPorIou: melhor par primeiro, sem reutilizar, sobras voltam como livres", () => {
  const t1 = { box: [0, 0, 100, 200] }, t2 = { box: [300, 0, 100, 200] };
  const d1 = { box: [5, 5, 100, 200] }, d2 = { box: [310, 0, 100, 200] }, d3 = { box: [700, 0, 100, 200] };
  const { pares, livres } = casarPorIou([t1, t2], [d3, d2, d1]);
  assert.equal(pares.length, 2);
  assert.ok(pares.some(([t, d]) => t === t1 && d === d1) && pares.some(([t, d]) => t === t2 && d === d2));
  assert.deepEqual(livres, [d3]);
  assert.deepEqual(casarPorIou([], [d1]).livres, [d1]);
  assert.equal(casarPorIou([t1], [d3]).pares.length, 0, "sem sobreposição não casa");
});
