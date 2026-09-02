import { test } from "node:test";
import assert from "node:assert/strict";
import {
  iou, contencao, dedupe, geometria, mediana, formataDur, zonas,
  fileirasECadeiras, classificarNota, resumoSessao, csvRelatorio, valido, SCORE_MIN,
} from "../engine.js";

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
