// -*- coding: utf-8 -*-
/**
 * app.js — 국기·지도 찾기 화면 제어
 * 출제 방식(시작할 때 고름): 이름 + 위치(국기 보고 이름 → 지도에서 찾기) / 이름만 / 위치만(나라 이름을 보고 지도에서 찾기).
 * 규칙·점수 계산은 engine.js(GameEngine)에 있고, 여기는 화면·입력·지도 확대/이동만 다룬다.
 * 멀티플레이(multi.js)는 window.FlagApp으로 지도·화면 도구를 빌려 쓰고, 멀티 중에는 입력이 그쪽으로 간다.
 */
(function () {
  "use strict";

  const E = window.GameEngine;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = "flagmap.v1";
  const MODE_KEY = "flagmap.mode";
  const QUIT_ARM_MS = 3000; // 「나가기」를 이 시간 안에 한 번 더 눌러야 나간다
  const MODE_TEXT = {
    both: { label: "이름 + 위치", desc: "국기 → 이름 입력 → 지도에서 위치 선택." },
    name: { label: "이름만", desc: "국기 → 이름 입력. 정답 후 지도에 위치 표시." },
    place: { label: "위치만", desc: "국기·나라 이름 → 지도에서 위치 선택." },
  };
  const MAP_H = 394; // scripts/build_data.py가 만든 viewBox 높이
  const MIN_W = 50; // 최대 확대(지도 너비 50단위)
  const TALL_SLACK = 1.6; // 길쭉한 지도 칸에서 위아래로 비워 둘 수 있는 높이 배수
  const TAP_MOVE_PX = 8; // 이만큼 움직이면 누르기가 아니라 끌기

  let questions = [];
  let qi = 0;
  let results = [];
  let stage = "idle"; // name | place | reveal | idle
  let stageStart = 0;
  let rafId = null;
  let cur = null; // 지금 문제 기록 {country, nameOk, placeOk, km, nameScore, placeScore}
  let mode = "both"; // 혼자 하기 출제 방식

  /* ---------- 기록 ---------- */
  function loadStore() {
    try {
      return E.normalizeStore(JSON.parse(localStorage.getItem(STORE_KEY)));
    } catch (e) {
      return E.normalizeStore(null);
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
  applyView();

  function applyView() {
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  }
  // 보기 범위는 지도 칸의 세로/가로 비를 따른다. 폰 세로 화면처럼 칸이 세계 지도보다 길쭉하면
  // 세계 전체 대신 TALL_SLACK배 높이까지만 위아래를 비우고 그만큼 크게 보인다(나머지는 끌어서 본다).
  function boxAspect() {
    const r = svg.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r.height / r.width : FULL.h / FULL.w;
  }
  function maxW() {
    return Math.min(FULL.w, (FULL.h / boxAspect()) * TALL_SLACK);
  }
  function clampView() {
    view.w = Math.min(maxW(), Math.max(MIN_W, view.w));
    view.h = view.w * boxAspect();
    view.x = Math.min(FULL.w - view.w, Math.max(0, view.x));
    view.y = view.h >= FULL.h ? (FULL.h - view.h) / 2 : Math.min(FULL.h - view.h, Math.max(0, view.y));
  }
  function resetView() {
    view = { x: 0, y: 0, w: FULL.w };
    clampView();
    view.x = (FULL.w - view.w) / 2;
    clampView();
    applyView();
  }
  // 단계가 바뀌어 지도 칸 크기가 달라지면 보던 가운데를 유지한다
  new ResizeObserver(() => {
    const cx = view.x + view.w / 2;
    const cy = view.y + (view.h || 0) / 2;
    clampView();
    view.x = cx - view.w / 2;
    view.y = cy - view.h / 2;
    clampView();
    applyView();
  }).observe(svg);
  function zoomAt(factor, mx, my) {
    // (mx, my) 지도 좌표가 화면에서 제자리에 있도록 확대
    const nw = Math.min(maxW(), Math.max(MIN_W, view.w / factor));
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
    const a = boxAspect();
    let w = Math.max(box.w + pad * 2, (box.h + pad * 2) / a, 160);
    view = { x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - (w * a) / 2, w };
    clampView();
    applyView();
  }

  $("zoom-in").onclick = () => zoomAt(1.6, view.x + view.w / 2, view.y + view.h / 2);
  $("zoom-out").onclick = () => zoomAt(1 / 1.6, view.x + view.w / 2, view.y + view.h / 2);
  $("zoom-reset").onclick = resetView;
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
    for (const s of ["screen-home", "screen-lobby", "screen-play", "screen-result"]) $(s).classList.toggle("hidden", s !== id);
    $("hud").classList.toggle("hidden", id !== "screen-play");
  }
  function setStage(next) {
    stage = next;
    const play = $("screen-play");
    play.classList.toggle("name", next === "name" || next === "nameReveal");
    play.classList.toggle("place", next === "place" || next === "reveal");
    play.classList.toggle("reveal", next === "reveal" || next === "nameReveal");
    stageStart = performance.now();
  }
  /** 단계 이름: 이름+위치는 「1/2 · 나라 이름」, 한 단계만 풀면 단계 번호 없이. */
  function stageLabel(m, kind) {
    const text = kind === "name" ? "나라 이름" : "지도에서 찾기";
    return m === "both" ? `${kind === "name" ? 1 : 2}/2 · ${text}` : text;
  }
  function setPlayMode(m) {
    const play = $("screen-play");
    for (const k of E.MODES) play.classList.toggle("mode-" + k, k === m);
  }
  /** 타이머 막대와 남은 초. rest면 답하는 단계가 아니라 회색 막대만(초는 안 보임). */
  function setTimer(leftMs, limitMs, rest) {
    const ratio = Math.max(0, Math.min(1, leftMs / limitMs));
    const low = !rest && ratio < 0.3;
    const bar = $("timer-bar");
    bar.style.width = ratio * 100 + "%";
    bar.classList.toggle("low", low);
    bar.classList.toggle("rest", Boolean(rest));
    const sec = $("timer-sec");
    sec.textContent = rest || leftMs <= 0 ? "" : `${Math.ceil(leftMs / 1000)}초`;
    sec.classList.toggle("low", low);
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
    const leftMs = Math.max(0, limit - (performance.now() - stageStart));
    setTimer(leftMs, limit, false);
    if (leftMs <= 0) {
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
    $("timer-sec").textContent = "";
  }

  /* ---------- 한 판 ---------- */
  function startGame() {
    disarmQuit();
    questions = E.pickRound(window.WORLD, E.ROUND_SIZE);
    qi = 0;
    results = [];
    cur = null;
    $("hud-score").textContent = "0";
    $("screen-play").classList.remove("multi", "reveal");
    setPlayMode(mode);
    for (const id of ["board", "btn-confirm", "hud-room"]) $(id).classList.add("hidden");
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
    resetView();
    $("hud-q").textContent = `${qi} / ${questions.length}`;
    $("flag").src = `primary_data/flags/${c.code}.svg`;
    $("feedback").className = "feedback";
    $("feedback").textContent = "";
    $("btn-next").classList.add("hidden");
    if (mode === "place") return startPlace();
    $("stage").textContent = stageLabel(mode, "name");
    $("ask").textContent = "이 국기의 나라는?";
    $("name-form").classList.remove("hidden");
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
    if (mode === "name") {
      // 이름만: 다음 문제로 넘어가기 전에 지도에서 위치를 보여 준다
      setStage("nameReveal");
      showAnswerOnMap(c);
      showNext();
      return;
    }
    stage = "wait";
    setTimeout(startPlace, 1000);
  }

  /** 정답 나라를 칠하고 그 나라로 지도를 옮긴다. */
  function showAnswerOnMap(c) {
    const answerPath = svg.querySelector(`path[data-c="${c.code}"]`);
    answerPath.classList.add("answer");
    svg.querySelector(`circle[data-m="${c.code}"]`).classList.add("on");
    const b = answerPath.getBBox();
    fitTo({ x: b.x, y: b.y, w: b.width, h: b.height });
  }
  function showNext() {
    $("btn-next").textContent = qi >= questions.length ? "결과 보기 ▶" : "다음 ▶";
    $("btn-next").classList.remove("hidden");
    $("btn-next").focus({ preventScroll: true });
  }

  function startPlace() {
    const c = cur.country;
    $("name-form").classList.add("hidden");
    $("stage").textContent = stageLabel(mode, "place");
    $("ask").innerHTML = `지도에서 <b>${c.name}</b>${objParticle(c.name)} 누르세요`;
    $("feedback").className = "feedback";
    $("feedback").textContent = "";
    setStage("place");
    if (window.matchMedia("(max-width: 820px)").matches) $("mapcard").scrollIntoView({ behavior: "smooth", block: "center" });
    startTimer();
  }

  function onMapTap(clientX, clientY) {
    const hitEl = document.elementFromPoint(clientX, clientY);
    const path = hitEl && hitEl.closest ? hitEl.closest(".wmap .land path") : null;
    if (multiActive()) return window.FlagMulti.onMapTap({ xy: toMap(clientX, clientY), path });
    if (stage !== "place") return;
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

    setStage("reveal");
    showNext();
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
    const s = E.summarize(results, mode);
    const { store, isBest } = E.recordBest(loadStore(), mode, s.total);
    saveStore(store);
    showResult({
      mode,
      total: s.total,
      max: s.max,
      best: isBest && s.total > 0 ? "🎉 이 방식 최고 기록!" : `${MODE_TEXT[mode].label} 최고 기록 ${store.best[mode].toLocaleString()}점`,
      nameHits: s.nameHits,
      placeHits: s.placeHits,
      entries: results,
    });
    for (const id of ["btn-again", "btn-home"]) $(id).classList.remove("hidden");
    for (const id of ["r-rank", "r-wait", "btn-r-leave", "btn-to-lobby"]) $(id).classList.add("hidden");
    show("screen-result");
  }

  /** 결과 화면 공통 부분 (혼자·멀티). entries: [{country, nameOk, placeOk, km, nameScore, placeScore}] */
  function showResult(r) {
    const st = E.modeStages(r.mode);
    const n = r.entries.length;
    $("r-title").textContent = `결과 · ${MODE_TEXT[r.mode].label}`;
    $("r-total").textContent = r.total.toLocaleString();
    $("r-max").textContent = ` / ${r.max.toLocaleString()}`;
    $("r-best").textContent = r.best;
    $("r-name").textContent = `${r.nameHits} / ${n}`;
    $("r-place").textContent = `${r.placeHits} / ${n}`;
    $("r-stats").classList.remove("hidden");
    $("r-stat-name").classList.toggle("hidden", !st.name);
    $("r-stat-place").classList.toggle("hidden", !st.place);
    const wrong = r.entries.filter((e) => (st.name && !e.nameOk) || (st.place && !e.placeOk)).length;
    $("r-review-title").textContent = !n ? "" : wrong ? `문제별 결과 · 틀린 문제 ${wrong}개` : "문제별 결과 · 모두 맞혔어요!";
    $("r-review").innerHTML = r.entries.map((e, i) => reviewRow(e, i, st)).join("");
  }
  function reviewRow(e, i, st) {
    const tags = [];
    if (st.name) tags.push(e.nameOk ? `<span class="o">이름 ✓ +${e.nameScore}</span>` : '<span class="x">이름 ✗</span>');
    if (st.place) {
      if (e.placeOk) tags.push(`<span class="o">위치 ✓ +${e.placeScore}</span>`);
      else if (e.km != null && isFinite(e.km)) tags.push(`<span class="x">위치 ✗ ${e.km.toLocaleString()}km</span>${e.placeScore ? ` +${e.placeScore}` : ""}`);
      else tags.push('<span class="x">위치 ✗ 시간 끝</span>');
    }
    const bad = (st.name && !e.nameOk) || (st.place && !e.placeOk);
    return (
      `<li class="${bad ? "bad" : ""}"><span class="no">${i + 1}</span><img src="primary_data/flags/${e.country.code}.svg" alt="">` +
      `<span class="nm">${e.country.name}</span><b class="pt">${e.nameScore + e.placeScore}</b><span class="tags">${tags.join(" · ")}</span></li>`
    );
  }

  /* ---------- 입력 ---------- */
  function multiActive() {
    return Boolean(window.FlagMulti && window.FlagMulti.active);
  }
  $("name-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (multiActive()) return window.FlagMulti.submitName($("name-in").value);
    submitName($("name-in").value, false);
  });
  // 한글 조합 중 Enter는 무시한다 (조합이 끝난 다음 Enter에서 제출)
  $("name-in").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.isComposing) e.preventDefault();
  });
  $("btn-pass").onclick = () => (multiActive() ? window.FlagMulti.submitName("") : submitName("", false));
  $("btn-next").onclick = nextQuestion;
  $("btn-start").onclick = startGame;
  $("btn-again").onclick = () => (multiActive() ? window.FlagMulti.again() : startGame());
  $("btn-home").onclick = goHome;

  // 나가기: 실수로 눌러도 판이 끝나지 않게 한 번 더 눌러야 나간다
  let quitArmed = 0;
  let quitTimer = null;
  function disarmQuit() {
    quitArmed = 0;
    clearTimeout(quitTimer);
    $("btn-quit").textContent = "나가기";
    $("btn-quit").classList.remove("armed");
  }
  $("btn-quit").onclick = () => {
    if (!quitArmed) {
      quitArmed = performance.now();
      $("btn-quit").textContent = "한 번 더 누르면 나가요";
      $("btn-quit").classList.add("armed");
      quitTimer = setTimeout(disarmQuit, QUIT_ARM_MS);
      return;
    }
    disarmQuit();
    if (multiActive()) return window.FlagMulti.leave();
    goHome();
  };
  function goHome() {
    stopTimer();
    stage = "idle";
    cur = null;
    $("screen-play").classList.remove("name", "place", "reveal");
    show("screen-home");
    renderHomeBest();
  }

  /* ---------- 출제 방식 고르기 (처음 화면·대기실이 같이 쓴다) ---------- */
  function setSeg(el, m) {
    for (const b of el.querySelectorAll("[data-mode]")) {
      const on = b.dataset.mode === m;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    const desc = $(el.id + "-desc");
    if (desc) desc.textContent = `${MODE_TEXT[m].desc} 만점 ${E.maxScore(m).toLocaleString()}`;
  }
  function bindSeg(el, onPick) {
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-mode]");
      if (b && !b.disabled) onPick(b.dataset.mode);
    });
    // 라디오 묶음답게 ←·→로 옮긴다
    el.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const btns = [...el.querySelectorAll("[data-mode]")];
      const i = btns.findIndex((b) => b.getAttribute("aria-checked") === "true");
      const next = btns[(i + (e.key === "ArrowRight" ? 1 : btns.length - 1)) % btns.length];
      if (next.disabled) return;
      e.preventDefault();
      onPick(next.dataset.mode);
      next.focus();
    });
  }
  function renderHomeBest() {
    const store = loadStore();
    const best = store.best[mode];
    $("home-best").textContent = best ? `${MODE_TEXT[mode].label} 최고 기록 ${best.toLocaleString()}점` : store.plays ? "이 방식은 아직 기록이 없어요" : "";
  }
  function pickMode(m) {
    mode = E.normalizeMode(m);
    setSeg($("mode-solo"), mode);
    renderHomeBest();
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch (e) {
      /* 기록 없이 진행 */
    }
  }
  bindSeg($("mode-solo"), pickMode);
  try {
    mode = E.normalizeMode(localStorage.getItem(MODE_KEY));
  } catch (e) {
    mode = "both";
  }
  pickMode(mode);

  /* ---------- 처음 화면 탭 ---------- */
  function selectTab(which) {
    for (const k of ["solo", "multi"]) {
      $("tab-" + k).setAttribute("aria-selected", String(k === which));
      $("panel-" + k).classList.toggle("hidden", k !== which);
    }
  }
  $("tab-solo").onclick = () => selectTab("solo");
  $("tab-multi").onclick = () => selectTab("multi");

  // 멀티플레이가 빌려 쓰는 도구
  window.FlagApp = {
    svg, fx, toMap, pxPerUnit, fitTo, resetView, clearMapFx, show, feedback, objParticle, stopTimer, disarmQuit,
    setTimer, stageLabel, setPlayMode, showAnswerOnMap, showResult, setSeg, bindSeg, selectTab, MODE_TEXT,
  };
})();
