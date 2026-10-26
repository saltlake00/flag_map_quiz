// -*- coding: utf-8 -*-
/**
 * engine.js
 * 국기·지도 찾기 핵심 규칙 엔진 (화면과 무관한 순수 함수만)
 * - 나라 이름 정규화·별칭·편집거리(오타 허용) 채점 — abstract_quiz와 같은 규칙
 * - 지도 좌표 ↔ 경위도 변환, 대략 거리(km)
 * - 지도 클릭 판정(경계 바로 바깥도 인정해 작은 나라를 누르기 쉽게)
 * - 시간에 따른 점수
 */

(function (global) {
  "use strict";

  // scripts/build_data.py의 W·LAT_TOP과 같아야 한다 (등장방형 투영)
  const MAP = { W: 1000, LAT_TOP: 84 };
  const ROUND_SIZE = 10;
  const NAME_LIMIT_MS = 15000;
  const PLACE_LIMIT_MS = 20000;
  const NEAR_TAP_PX = 24; // 경계 바깥을 눌러도 화면에서 이만큼 안이고
  const NEAR_TAP_KM = 400; // 실제로도 이만큼 안이면 정답 (작은 나라·섬)
  const NEAR_KM = 2000; // 이 거리 안에서 틀리면 가까운 만큼 부분 점수

  /** 소문자화하고 영문·숫자·완성형 한글만 남긴다 (띄어쓰기·가운뎃점·마침표 무시). */
  function normalizeText(raw) {
    if (!raw || typeof raw !== "string") return "";
    return raw.toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[n];
  }

  /** 나라 이름 채점. 이름과 별칭을 받고, 5글자 이상 이름은 한 글자 오타를 봐준다. */
  function checkName(userInput, country) {
    const input = normalizeText(userInput);
    if (!input || !country) return false;
    const answers = [country.name].concat(country.alias || []);
    for (const ans of answers) {
      const norm = normalizeText(ans);
      if (!norm) continue;
      if (input === norm) return true;
      if (norm.length >= 5 && input.length >= 4 && levenshtein(input, norm) <= 1) return true;
    }
    return false;
  }

  function toLonLat(x, y) {
    return { lon: (x / MAP.W) * 360 - 180, lat: MAP.LAT_TOP - (y / MAP.W) * 360 };
  }

  function haversineKm(a, b) {
    const R = 6371;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** SVG 경로 d 문자열("M1 2L3 4Z...")의 꼭짓점 목록. */
  function parsePathPoints(d) {
    const pts = [];
    const re = /[ML](-?[\d.]+) (-?[\d.]+)/g;
    let m;
    while ((m = re.exec(d || ""))) pts.push([parseFloat(m[1]), parseFloat(m[2])]);
    return pts;
  }

  /** 지도 좌표 한 점에서 나라 경계 꼭짓점까지 가장 가까운 거리(km). */
  function nearestKm(pointXY, countryPointsXY) {
    const p = toLonLat(pointXY[0], pointXY[1]);
    let best = Infinity;
    for (const q of countryPointsXY) {
      const km = haversineKm(p, toLonLat(q[0], q[1]));
      if (km < best) best = km;
    }
    return best;
  }

  /** 지도 좌표 한 점에서 가장 가까운 꼭짓점과 그 거리(지도 단위·km). */
  function nearestVertex(pointXY, countryPointsXY) {
    let best = null;
    let bd = Infinity;
    for (const q of countryPointsXY) {
      const d = (q[0] - pointXY[0]) ** 2 + (q[1] - pointXY[1]) ** 2;
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    if (!best) return { xy: null, units: Infinity, km: Infinity };
    return { xy: best, units: Math.sqrt(bd), km: nearestKm(pointXY, countryPointsXY) };
  }

  /**
   * 지도 클릭 판정.
   * hitCode: 누른 나라 경로의 data-c (출제 나라가 아니면 null)
   * clickXY: 지도 좌표, pxPerUnit: 지금 확대에서 지도 1단위가 화면 몇 px인지
   * answerPoints: 정답 나라 경계 꼭짓점(지도 좌표)
   * 경로 안을 누르면 정답. 경계 바로 바깥(화면 NEAR_TAP_PX 이내이면서 실제 NEAR_TAP_KM 이내)도
   * 정답으로 쳐서 작은 나라·섬을 누르기 쉽게 한다. 다만 다른 출제 나라를 눌렀으면 그 나라를 고른 것으로 본다.
   */
  function judgePlace(opts) {
    const { hitCode, answerCode, clickXY, pxPerUnit, answerPoints } = opts;
    if (hitCode && hitCode === answerCode) return { correct: true, km: 0, byNear: false };
    const near = nearestVertex(clickXY, answerPoints || []);
    if (!hitCode && near.units * pxPerUnit <= NEAR_TAP_PX && near.km <= NEAR_TAP_KM) {
      return { correct: true, km: 0, byNear: true };
    }
    return { correct: false, km: Math.round(near.km), byNear: false };
  }

  /** 맞힌 시점에 따른 점수: 바로 맞히면 100, 제한 시간 끝에 맞히면 20 (abstract_quiz와 같은 곡선). */
  function timeScore(elapsedMs, limitMs) {
    const ratio = Math.min(1, Math.max(0, elapsedMs / limitMs));
    return Math.max(20, Math.round(100 * (1 - 0.8 * ratio)));
  }

  function nameScore(correct, elapsedMs) {
    return correct ? timeScore(elapsedMs, NAME_LIMIT_MS) : 0;
  }

  /** 위치 점수. 틀려도 NEAR_KM 안이면 가까운 만큼 최대 40점. */
  function placeScore(result, elapsedMs) {
    if (!result) return 0;
    if (result.correct) return timeScore(elapsedMs, PLACE_LIMIT_MS);
    if (!isFinite(result.km)) return 0;
    return Math.round(40 * Math.max(0, 1 - result.km / NEAR_KM));
  }

  /** 문제 n개를 겹치지 않게 뽑는다. rng를 넘기면 결정적으로. */
  function pickRound(list, n = ROUND_SIZE, rng = Math.random) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, Math.min(n, a.length));
  }

  /** 판 결과 요약. results: [{country, nameOk, placeOk, km, nameScore, placeScore}] */
  function summarize(results) {
    const total = results.reduce((s, r) => s + r.nameScore + r.placeScore, 0);
    return {
      total,
      max: results.length * 200,
      nameHits: results.filter((r) => r.nameOk).length,
      placeHits: results.filter((r) => r.placeOk).length,
      missed: results.filter((r) => !r.nameOk || !r.placeOk),
    };
  }

  const api = {
    MAP,
    ROUND_SIZE,
    NAME_LIMIT_MS,
    PLACE_LIMIT_MS,
    NEAR_TAP_PX,
    NEAR_TAP_KM,
    NEAR_KM,
    normalizeText,
    levenshtein,
    checkName,
    toLonLat,
    haversineKm,
    parsePathPoints,
    nearestKm,
    nearestVertex,
    judgePlace,
    timeScore,
    nameScore,
    placeScore,
    pickRound,
    summarize,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.GameEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
