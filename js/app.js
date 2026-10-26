// -*- coding: utf-8 -*-
/**
 * app.js — 국기·지도 찾기 화면 제어
 * 한 문제 = 1단계(국기 보고 이름 쓰기) → 2단계(지도에서 그 나라 누르기).
 * 규칙·점수 계산은 engine.js(GameEngine)에 있고, 여기는 화면·입력·지도 확대/이동만 다룬다.
 */
(function () {
  "use strict";

  const E = window.GameEngine;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = "flagmap.v1";
  const MAP_H = 394; // scripts/build_data.py가 만든 viewBox 높이
  const MIN_W = 50; // 최대 확대(지도 너비 50단위)
  const TAP_MOVE_PX = 8; // 이만큼 움직이면 누르기가 아니라 끌기

  let questions = [];
  let qi = 0;
  let results = [];
  let stage = "idle"; // name | place | reveal | idle
  let stageStart = 0;
  let rafId = null;
  let cur = null; // 지금 문제 기록 {country, nameOk, placeOk, km, nameScore, placeScore}

  /* ---------- 기록 ---------- */
  function loadStore() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || { best: 0, plays: 0 };
    } catch (e) {
      return { best: 0, plays: 0 };
    }
  }
  function saveStore(s) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(s));
    } catch (e) {
      /* 사생활 보호 창 등에서는 기록 없이 진행 */
    }
  }

  /* ---------- 지도 ---------- */
  $("map-wrap").innerHTML = window.MAP_SVG;
  const svg = document.querySelector(".wmap");
  const fx = svg.querySelector(".fx");
  const FULL = { x: 0, y: 0, w: E.MAP.W, h: MAP_H };
  let view = { ...FULL };

  function applyView() {
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  }
  function clampView() {
    view.w = Math.min(FULL.w, Math.max(MIN_W, view.w));
    view.h = (view.w * FULL.h) / FULL.w;
    view.x = Math.min(FULL.w - view.w, Math.max(0, view.x));
    view.y = Math.min(FULL.h - view.h, Math.max(0, view.y));
  }
  function zoomAt(factor, mx, my) {
    // (mx, my) 지도 좌표가 화면에서 제자리에 있도록 확대
    const nw = Math.min(FULL.w, Math.max(MIN_W, view.w / factor));
    const k = nw / view.w;
    view.x = mx - (mx - view.x) * k;
    view.y = my - (my - view.y) * k;
    view.w = nw;
    clampView();
    applyView();
  }
  function toMap(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    return [view.x + ((clientX - r.left) / r.width) * view.w, view.y + ((clientY - r.top) / r.height) * view.h];
  }
  function pxPerUnit() {
    return svg.getBoundingClientRect().width / view.w;
  }
  function fitTo(box) {
    const pad = 30;
    let w = Math.max(box.w + pad * 2, ((box.h + pad * 2) * FULL.w) / FULL.h, 160);
    view = { x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - (w * FULL.h) / FULL.w / 2, w };
    clampView();
    applyView();
  }

  $("zoom-in").onclick = () => zoomAt(1.6, view.x + view.w / 2, view.y + view.h / 2);
  $("zoom-out").onclick = () => zoomAt(1 / 1.6, view.x + view.w / 2, view.y + view.h / 2);
  $("zoom-reset").onclick = () => {
    view = { ...FULL };
    applyView();
  };
  svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const [mx, my] = toMap(e.clientX, e.clientY);
      zoomAt(e.deltaY < 0 ? 1.25 : 0.8, mx, my);
    },
    { passive: false }
  );

  // 끌어서 이동, 두 손가락으로 확대, 움직이지 않고 떼면 누르기
  const pointers = new Map();
  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) drag = { sx: e.clientX, sy: e.clientY, moved: false, view: { ...view } };
    else drag = { moved: true, pinch: pinchState() };
  });
  svg.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!drag) return;
    if (pointers.size >= 2) {
      const p = pinchState();
      if (drag.pinch && p.dist > 0) {
        const [mx, my] = toMap(p.cx, p.cy);
        zoomAt(p.dist / drag.pinch.dist, mx, my);
      }
      drag.pinch = p;
      return;
    }
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < TAP_MOVE_PX) return;
    drag.moved = true;
    if (!drag.view) return;
    const k = drag.view.w / svg.getBoundingClientRect().width;
    view = { ...drag.view, x: drag.view.x - dx * k, y: drag.view.y - dy * k };
    clampView();
    applyView();
  });
  function endPointer(e) {
    const wasTap = drag && !drag.moved && pointers.size === 1;
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      if (wasTap && e.type === "pointerup") onMapTap(e.clientX, e.clientY);
      drag = null;
    }
  }
  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);
  function pinchState() {
    const [a, b] = [...pointers.values()];
    if (!b) return { dist: 0, cx: a.x, cy: a.y };
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  function clearMapFx() {
    svg.querySelectorAll(".answer,.guess,.on").forEach((el) => el.classList.remove("answer", "guess", "on"));
    fx.innerHTML = "";
  }

  /* ---------- 화면 전환 ---------- */
  function show(id) {
    for (const s of ["screen-home", "screen-play", "screen-result"]) $(s).classList.toggle("hidden", s !== id);
    $("hud").classList.toggle("hidden", id !== "screen-play");
  }
  function setStage(next) {
    stage = next;
    const play = $("screen-play");
    play.classList.toggle("name", next === "name");
    play.classList.toggle("place", next === "place" || next === "reveal");
    stageStart = performance.now();
  }
  function feedback(kind, text, sub) {
    const el = $("feedback");
    el.className = "feedback";
    void el.offsetWidth; // 같은 효과를 연달아 다시 재생
    el.className = "feedback " + kind;
    el.innerHTML = text + (sub ? `<small>${sub}</small>` : "");
  }
  function addScore(n) {
    const total = results.reduce((s, r) => s + r.nameScore + r.placeScore, 0) + (cur ? cur.nameScore + cur.placeScore : 0);
    const el = $("hud-score");
    el.textContent = total;
    if (n > 0) {
      el.classList.remove("bump");
      void el.offsetWidth;
      el.classList.add("bump");
    }
  }

  /* ---------- 타이머 ---------- */
  function tick() {
    const limit = stage === "name" ? E.NAME_LIMIT_MS : E.PLACE_LIMIT_MS;
    const left = Math.max(0, 1 - (performance.now() - stageStart) / limit);
    const bar = $("timer-bar");
    bar.style.width = left * 100 + "%";
    bar.classList.toggle("low", left < 0.3);
    if (left <= 0) {
      if (stage === "name") submitName("", true);
      else if (stage === "place") submitPlace(null);
      return;
    }
    rafId = requestAnimationFrame(tick);
  }
  function startTimer() {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }
  function stopTimer() {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  /* ---------- 한 판 ---------- */
  function startGame() {
    questions = E.pickRound(window.WORLD, E.ROUND_SIZE);
    qi = 0;
    results = [];
    cur = null;
    $("hud-score").textContent = "0";
    show("screen-play");
    nextQuestion();
  }

  function nextQuestion() {
    if (cur) results.push(cur);
    if (qi >= questions.length) return finish();
    const c = questions[qi];
    cur = { country: c, nameOk: false, placeOk: false, km: null, nameScore: 0, placeScore: 0 };
    qi += 1;
    clearMapFx();
    view = { ...FULL };
    applyView();
    $("hud-q").textContent = `${qi} / ${questions.length}`;
    $("flag").src = `primary_data/flags/${c.code}.svg`;
    $("stage").textContent = "1단계 · 나라 이름";
    $("ask").textContent = "이 국기의 나라는?";
    $("feedback").className = "feedback";
    $("feedback").textContent = "";
    $("name-form").classList.remove("hidden");
    $("btn-next").classList.add("hidden");
    const input = $("name-in");
    input.value = "";
    input.disabled = false;
    setStage("name");
    input.focus();
    startTimer();
  }

  function submitName(value, timeout) {
    if (stage !== "name") return;
    stopTimer();
    const elapsed = performance.now() - stageStart;
    const c = cur.country;
    cur.nameOk = !timeout && E.checkName(value, c);
    cur.nameScore = E.nameScore(cur.nameOk, elapsed);
    $("name-in").disabled = true;
    $("name-in").blur();
    if (cur.nameOk) feedback("ok", `정답! +${cur.nameScore}`, c.name);
    else feedback("no", timeout ? "시간 끝!" : "아쉬워요", `정답은 ${c.name}`);
    addScore(cur.nameScore);
    stage = "wait";
    setTimeout(startPlace, 1000);
  }

  function startPlace() {
    const c = cur.country;
    $("name-form").classList.add("hidden");
    $("stage").textContent = "2단계 · 지도에서 찾기";
    $("ask").innerHTML = `지도에서 <b>${c.name}</b>${objParticle(c.name)} 누르세요`;
    $("feedback").className = "feedback";
    $("feedback").textContent = "";
    setStage("place");
    if (window.matchMedia("(max-width: 820px)").matches) $("mapcard").scrollIntoView({ behavior: "smooth", block: "center" });
    startTimer();
  }

  function onMapTap(clientX, clientY) {
    if (stage !== "place") return;
    const hitEl = document.elementFromPoint(clientX, clientY);
    const path = hitEl && hitEl.closest ? hitEl.closest(".wmap .land path") : null;
    submitPlace({ xy: toMap(clientX, clientY), path });
  }

  function submitPlace(tap) {
    if (stage !== "place") return;
    stopTimer();
    const elapsed = performance.now() - stageStart;
    const c = cur.country;
    const answerPath = svg.querySelector(`path[data-c="${c.code}"]`);
    const mark = svg.querySelector(`circle[data-m="${c.code}"]`);
    const answerPoints = E.parsePathPoints(answerPath.getAttribute("d"));
    let res;
    if (tap) {
      res = E.judgePlace({
        hitCode: tap.path ? tap.path.getAttribute("data-c") : null,
        answerCode: c.code,
        clickXY: tap.xy,
        pxPerUnit: pxPerUnit(),
        answerPoints,
      });
    } else {
      res = { correct: false, km: Infinity };
    }
    cur.placeOk = res.correct;
    cur.km = res.km;
    cur.placeScore = E.placeScore(res, elapsed);
    addScore(cur.placeScore);

    // 정답 나라를 칠하고, 틀렸으면 누른 곳과 정답을 선으로 잇는다
    answerPath.classList.add("answer");
    mark.classList.add("on");
    const box = answerPath.getBBox();
    let fit = { x: box.x, y: box.y, w: box.width, h: box.height };
    if (tap && !res.correct) {
      if (tap.path) tap.path.classList.add("guess");
      const [x, y] = tap.xy;
      const near = E.nearestVertex(tap.xy, answerPoints).xy;
      const fs = Math.max(8, Math.min(22, (Math.max(fit.w, Math.abs(x - near[0])) + 60) / 12));
      fx.innerHTML =
        `<line x1="${x}" y1="${y}" x2="${near[0]}" y2="${near[1]}"/>` +
        `<circle class="pin" cx="${x}" cy="${y}" r="${fs / 3}"/>` +
        `<text x="${(x + near[0]) / 2}" y="${(y + near[1]) / 2 - fs / 2}" font-size="${fs}" text-anchor="middle">약 ${res.km.toLocaleString()}km</text>`;
      const x0 = Math.min(fit.x, x);
      const y0 = Math.min(fit.y, y);
      fit = { x: x0, y: y0, w: Math.max(fit.x + fit.w, x) - x0, h: Math.max(fit.y + fit.h, y) - y0 };
    }
    fitTo(fit);

    if (res.correct) feedback("ok", `찾았어요! +${cur.placeScore}`, res.byNear ? "경계 바로 옆이라 정답" : c.where);
    else if (!tap) feedback("no", "시간 끝!", c.where);
    else feedback("no", `약 ${res.km.toLocaleString()}km 빗나감${cur.placeScore ? ` +${cur.placeScore}` : ""}`, c.where);

    stage = "reveal";
    $("btn-next").textContent = qi >= questions.length ? "결과 보기 ▶" : "다음 ▶";
    $("btn-next").classList.remove("hidden");
    $("btn-next").focus({ preventScroll: true });
  }

  /** 받침이 있으면 「을」, 없으면 「를」. */
  function objParticle(word) {
    const code = word.charCodeAt(word.length - 1) - 0xac00;
    if (code < 0 || code > 11171) return "을(를)";
    return code % 28 ? "을" : "를";
  }

  function finish() {
    stopTimer();
    stage = "idle";
    cur = null;
    const s = E.summarize(results);
    const store = loadStore();
    const isBest = s.total > store.best;
    store.best = Math.max(store.best, s.total);
    store.plays += 1;
    saveStore(store);

    $("r-total").textContent = s.total;
    $("r-max").textContent = ` / ${s.max}`;
    $("r-best").textContent = isBest ? "🎉 최고 기록!" : `최고 기록 ${store.best}점`;
    $("r-name").textContent = `${s.nameHits} / ${results.length}`;
    $("r-place").textContent = `${s.placeHits} / ${results.length}`;
    $("r-missed-title").textContent = s.missed.length ? `틀린 나라 ${s.missed.length}곳` : "모두 맞혔어요!";
    $("r-missed").innerHTML = s.missed
      .map((r) => {
        const name = r.nameOk ? '<span class="o">이름 ✓</span>' : '<span class="x">이름 ✗</span>';
        const place = r.placeOk
          ? '<span class="o">위치 ✓</span>'
          : `<span class="x">위치 ✗</span>${isFinite(r.km) ? ` (약 ${r.km.toLocaleString()}km)` : " (시간 끝)"}`;
        return `<li><img src="primary_data/flags/${r.country.code}.svg" alt=""><span class="nm">${r.country.name}</span><span class="tags">${name} · ${place}</span></li>`;
      })
      .join("");
    show("screen-result");
  }

  /* ---------- 입력 ---------- */
  $("name-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submitName($("name-in").value, false);
  });
  // 한글 조합 중 Enter는 무시한다 (조합이 끝난 다음 Enter에서 제출)
  $("name-in").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.isComposing) e.preventDefault();
  });
  $("btn-pass").onclick = () => submitName("", false);
  $("btn-next").onclick = nextQuestion;
  $("btn-start").onclick = startGame;
  $("btn-again").onclick = startGame;

  const store = loadStore();
  $("home-best").textContent = store.plays ? `최고 기록 ${store.best}점 · ${store.plays}판` : "";
})();
