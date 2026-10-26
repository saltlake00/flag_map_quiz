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
  const MULTI_PLACE_LIMIT_MS = 25000; // 멀티: 핀 놓고 확정하느라 5초 더 (docs/멀티플레이-규칙.md §1.1)
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
  function placeScore(result, elapsedMs, limitMs = PLACE_LIMIT_MS) {
    if (!result) return 0;
    if (result.correct) return timeScore(elapsedMs, limitMs);
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

  /** 방 비밀번호 해시 (abstract_quiz와 같은 FNV1a 64비트 결합). 빈 비밀번호면 빈 문자열 = 공개방. */
  function hashRoomPassword(password, roomCode = "") {
    const clean = (password || "").trim();
    if (!clean) return "";
    const salted = `fmq_salt_${String(roomCode).toUpperCase()}_${clean}`;
    let h1 = 0x811c9dc5;
    let h2 = 0xcbf29ce4;
    for (let i = 0; i < salted.length; i++) {
      const ch = salted.charCodeAt(i);
      h1 ^= ch;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= ch * 31;
      h2 = Math.imul(h2, 0x01000193) >>> 0;
    }
    return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }

  /** 읽기 쉬운 방 코드 (헷갈리는 O·0·I·1 제외). */
  function generateRoomCode(length = 5, rng = Math.random) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < length; i++) out += chars.charAt(Math.floor(rng() * chars.length));
    return out;
  }

  /** 멀티 순위: 총점, 같으면 이름+위치 맞힌 수, 그다음 닉네임 순. players: [{nick, total, nameHits, placeHits}] */
  function rankPlayers(players) {
    return players
      .slice()
      .sort((a, b) => b.total - a.total || b.nameHits + b.placeHits - (a.nameHits + a.placeHits) || a.nick.localeCompare(b.nick, "ko"));
  }

  /** 출제 방식: both(이름 → 위치), name(이름만), place(나라 이름을 보고 위치만). 모르는 값은 both. */
  const MODES = ["both", "name", "place"];
  function normalizeMode(mode) {
    return MODES.includes(mode) ? mode : "both";
  }
  /** 그 방식에서 푸는 단계. */
  function modeStages(mode) {
    const m = normalizeMode(mode);
    return { name: m !== "place", place: m !== "name" };
  }
  /** 문제 n개 만점: 단계마다 100점. */
  function maxScore(mode, n = ROUND_SIZE) {
    const s = modeStages(mode);
    return n * 100 * (Number(s.name) + Number(s.place));
  }

  /** 판 결과 요약. results: [{country, nameOk, placeOk, km, nameScore, placeScore}]. 틀린 문제는 푼 단계만 본다. */
  function summarize(results, mode = "both") {
    const s = modeStages(mode);
    const total = results.reduce((sum, r) => sum + r.nameScore + r.placeScore, 0);
    return {
      total,
      max: maxScore(mode, results.length),
      nameHits: results.filter((r) => r.nameOk).length,
      placeHits: results.filter((r) => r.placeOk).length,
      missed: results.filter((r) => (s.name && !r.nameOk) || (s.place && !r.placeOk)),
    };
  }

  /** 저장 기록을 {best: {both, name, place}, plays}로 맞춘다. 옛 기록({best: 숫자})은 이름+위치 기록으로 옮긴다. */
  function normalizeStore(raw) {
    const out = { best: { both: 0, name: 0, place: 0 }, plays: 0 };
    if (!raw || typeof raw !== "object") return out;
    out.plays = Math.max(0, Number(raw.plays) || 0);
    if (typeof raw.best === "number") out.best.both = Math.max(0, raw.best);
    else if (raw.best && typeof raw.best === "object") for (const m of MODES) out.best[m] = Math.max(0, Number(raw.best[m]) || 0);
    return out;
  }
  /** 한 판 끝: 판 수를 늘리고 그 방식 최고 기록을 고친다. 새 기록이면 isBest. */
  function recordBest(rawStore, mode, total) {
    const store = normalizeStore(rawStore);
    const m = normalizeMode(mode);
    const isBest = total > store.best[m];
    store.best[m] = Math.max(store.best[m], total);
    store.plays += 1;
    return { store, isBest };
  }

  const api = {
    MAP,
    ROUND_SIZE,
    NAME_LIMIT_MS,
    PLACE_LIMIT_MS,
    MULTI_PLACE_LIMIT_MS,
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
    MODES,
    normalizeMode,
    modeStages,
    maxScore,
    summarize,
    normalizeStore,
    recordBest,
    hashRoomPassword,
    generateRoomCode,
    rankPlayers,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.GameEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
