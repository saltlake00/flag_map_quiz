// -*- coding: utf-8 -*-
/**
 * multi.js — 국기·지도 찾기 멀티플레이 (규칙: docs/멀티플레이-규칙.md)
 *
 * 방장 브라우저가 진행을 맡는다: 문제를 뽑고, 단계를 넘기고, 총점을 센다. 상태 전체를 STATE_SYNC로 뿌린다.
 * 정답 판정은 각자 브라우저에서 한다. 지도 판정에 각자의 확대 상태(화면 px)가 필요하기 때문이고,
 * 친구끼리 쓰는 전제라 보내온 결과를 믿는다(abstract_quiz와 같은 신뢰 수준).
 * 통신은 net.js(RoomNetwork: 공개 MQTT 브로커 + 같은 기기 탭 채널 + PeerJS).
 *
 * 단계: lobby → [name → nameReveal → place → placeReveal] × 10 → final
 */
(function () {
  "use strict";

  const E = window.GameEngine;
  const A = window.FlagApp;
  const $ = (id) => document.getElementById(id);
  const NICK_KEY = "flagmap.nick";
  const NAME_REVEAL_MS = 2500;
  const PLACE_REVEAL_MS = 6000;
  const GRACE_MS = 1500; // 시간 끝 뒤 늦게 도착하는 답을 기다리는 여유
  const PING_MS = 3000;
  const KEEPALIVE_MS = 3000; // 방장이 바뀐 게 없어도 이 간격으로 상태를 다시 보낸다
  const AWAY_MS = 10000; // 이만큼 소식이 없는 참가자는 「전원 답」 판정에서 뺀다
  const HOST_LOST_MS = 15000;
  const LIMIT = {
    name: E.NAME_LIMIT_MS,
    nameReveal: NAME_REVEAL_MS,
    place: E.MULTI_PLACE_LIMIT_MS,
    placeReveal: PLACE_REVEAL_MS,
  };
  const PLAY_PHASES = ["name", "nameReveal", "place", "placeReveal"];
  const byCode = new Map(window.WORLD.map((c) => [c.code, c]));

  const M = { active: false, onMapTap, submitName, again };
  window.FlagMulti = M;

  let net = null;
  let isHost = false;
  let myId = "";
  let room = null; // 방장: 정본. 참가자: 마지막으로 받은 사본

  // 방장 전용
  let endsAt = 0;
  let lastSync = 0;
  let hostLoop = null;
  const lastSeen = new Map();

  // 내 화면
  let localEnds = 0;
  let shownKey = "";
  let myName = null;
  let myPlace = null;
  let pin = null; // {xy, hitCode, pxPerUnit, at}
  let stageStartLocal = 0;
  let rafId = null;
  let pingTimer = null;
  let lastHostMsg = 0;

  /* ---------- 도구 ---------- */
  const now = () => performance.now();
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }
  let toastTimer = null;
  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
  }
  function alertHome(text) {
    $("mp-alert").textContent = text || "";
    $("mp-alert").classList.toggle("hidden", !text);
  }
  function randomNick() {
    return "손님" + Math.floor(100 + Math.random() * 900);
  }
  function country() {
    return room && room.qi >= 0 ? byCode.get(room.codes[room.qi]) : null;
  }
  function me() {
    return room && room.players[myId];
  }
  function ansOf(uid) {
    return (room && room.ans[uid]) || {};
  }

  /* ---------- 방장: 진행 ---------- */
  function newRoom(code) {
    return { code, phase: "lobby", qi: -1, codes: [], left: 0, players: {}, ans: {} };
  }
  function addPlayer(uid, nick, host) {
    let clean = (nick || randomNick()).trim().slice(0, 12) || randomNick();
    const taken = Object.entries(room.players)
      .filter(([id]) => id !== uid)
      .map(([, p]) => p.nick);
    if (taken.includes(clean)) {
      let n = 2;
      while (taken.includes(clean + n)) n += 1;
      clean += n;
    }
    const old = room.players[uid];
    if (old) {
      old.nick = clean;
      return old;
    }
    const playing = PLAY_PHASES.includes(room.phase);
    room.players[uid] = { nick: clean, isHost: Boolean(host), total: 0, nameHits: 0, placeHits: 0, spectating: playing };
    return room.players[uid];
  }
  function isAway(uid) {
    if (uid === myId) return false;
    return now() - (lastSeen.get(uid) || 0) > AWAY_MS;
  }
  function snapshot() {
    const s = JSON.parse(JSON.stringify(room));
    s.left = Math.max(0, endsAt - now());
    for (const [uid, p] of Object.entries(s.players)) p.away = isAway(uid);
    // 지도 단계 중에는 남의 핀 위치를 보내지 않는다 (확정했다는 사실만)
    if (s.phase === "place") for (const a of Object.values(s.ans)) if (a.place) a.place = { done: true };
    return s;
  }
  function sync() {
    if (!isHost || !net) return;
    lastSync = now();
    const s = snapshot();
    net.broadcastFromHost({ type: "STATE_SYNC", state: s });
    applyState(s, true);
  }
  function setPhase(phase, ms) {
    room.phase = phase;
    endsAt = now() + ms;
    sync();
  }
  function startRound() {
    room.codes = E.pickRound(window.WORLD, E.ROUND_SIZE).map((c) => c.code);
    room.qi = -1;
    for (const p of Object.values(room.players)) Object.assign(p, { total: 0, nameHits: 0, placeHits: 0, spectating: false });
    nextQuestion();
  }
  function nextQuestion() {
    room.qi += 1;
    room.ans = {};
    if (room.qi >= room.codes.length) return setPhase("final", 0);
    setPhase("name", LIMIT.name);
  }
  function players() {
    return Object.entries(room.players).filter(([, p]) => !p.spectating);
  }
  /** 이번 단계(name|place) 답을 안 낸 사람은 무응답으로 채우고 총점에 더한다. */
  function closeStage(kind) {
    for (const [uid, p] of players()) {
      const a = (room.ans[uid] = room.ans[uid] || {});
      if (!a[kind]) a[kind] = kind === "name" ? { ok: false, score: 0 } : { ok: false, km: null, score: 0, xy: null };
      p.total += a[kind].score;
      if (a[kind].ok) p[kind === "name" ? "nameHits" : "placeHits"] += 1;
    }
  }
  function hostTick() {
    if (!room) return;
    const t = now();
    const waiting = players().filter(([uid]) => !isAway(uid));
    if (room.phase === "name" || room.phase === "place") {
      const kind = room.phase;
      const allDone = waiting.length > 0 && waiting.every(([uid]) => ansOf(uid)[kind]);
      if (allDone || t > endsAt + GRACE_MS) {
        closeStage(kind);
        if (kind === "name") setPhase("nameReveal", LIMIT.nameReveal);
        else setPhase("placeReveal", LIMIT.placeReveal);
        return;
      }
    } else if (room.phase === "nameReveal" && t >= endsAt) {
      return setPhase("place", LIMIT.place);
    } else if (room.phase === "placeReveal" && t >= endsAt) {
      return nextQuestion();
    }
    if (t - lastSync > KEEPALIVE_MS) sync();
  }
  function onHostMessage(msg) {
    if (!room || !msg || !msg.uid) return;
    lastSeen.set(msg.uid, now());
    const p = room.players[msg.uid];
    if (msg.type === "LEAVE") {
      delete room.players[msg.uid];
      delete room.ans[msg.uid];
      return sync();
    }
    if (!p || p.spectating || msg.qi !== room.qi) return;
    const a = (room.ans[msg.uid] = room.ans[msg.uid] || {});
    const score = Math.max(0, Math.min(100, Math.round(Number(msg.score) || 0)));
    if (msg.type === "NAME" && room.phase === "name" && !a.name) {
      a.name = { ok: Boolean(msg.ok), score };
      sync();
    } else if (msg.type === "PLACE" && room.phase === "place" && !a.place) {
      const xy = Array.isArray(msg.xy) && msg.xy.length === 2 ? msg.xy.map(Number) : null;
      a.place = { ok: Boolean(msg.ok), km: Number.isFinite(msg.km) ? msg.km : null, score, xy };
      sync();
    }
  }

  /* ---------- 방 만들기·참가·나가기 ---------- */
  function readNick() {
    const nick = $("mp-nick").value.trim() || randomNick();
    $("mp-nick").value = nick;
    try {
      localStorage.setItem(NICK_KEY, nick);
    } catch (e) {
      /* 기록 없이 진행 */
    }
    return nick;
  }
  function netCallbacks() {
    return {
      onStatus: ({ text }) => {
        $("lobby-net").textContent = text;
      },
      onError: (text) => alertHome(text),
      onHostReady: ({ roomCode, nick }) => {
        myId = net.myId;
        room = newRoom(roomCode);
        addPlayer(myId, nick, true);
        M.active = true;
        hostLoop = setInterval(hostTick, 250);
        alertHome("");
        sync();
      },
      onJoinRequest: ({ uid, nick }) => {
        if (!room) return { ok: false, reason: "방이 아직 준비되지 않았습니다." };
        if (!room.players[uid] && Object.keys(room.players).length >= 12) return { ok: false, reason: "방이 가득 찼습니다 (최대 12명)." };
        const p = addPlayer(uid, nick, false);
        lastSeen.set(uid, now());
        toast(`${p.nick}님이 들어왔습니다${p.spectating ? " (다음 판부터 참가)" : ""}`);
        setTimeout(sync, 30);
        return { ok: true, state: snapshot() };
      },
      onPeerLeave: (uid) => {
        lastSeen.set(uid, 0);
        sync();
      },
      onHostMessage,
      onAuthOk: (data) => {
        myId = net.myId;
        M.active = true;
        alertHome("");
        lastHostMsg = now();
        pingTimer = setInterval(guestTick, PING_MS);
        if (data.state) applyState(data.state, false);
      },
      onAuthFail: (data) => alertHome(data.reason || "입장하지 못했습니다."),
      onGuestMessage: (data) => {
        if (data.type !== "STATE_SYNC" || !data.state) return;
        lastHostMsg = now();
        applyState(data.state, false);
      },
    };
  }
  function create() {
    alertHome("");
    leave(true);
    isHost = true;
    net = new window.RoomNetwork(netCallbacks());
    net.createRoom({ roomCode: E.generateRoomCode(5), nick: readNick(), password: $("mp-pass").value });
  }
  function join() {
    const code = $("mp-code").value.trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) return alertHome("방 코드 5자리를 넣어 주세요.");
    leave(true);
    isHost = false;
    net = new window.RoomNetwork(netCallbacks());
    alertHome(`방 ${code}에 연결하는 중…`);
    net.joinRoom({ roomCode: code, nick: readNick(), password: $("mp-pass").value });
  }
  function guestTick() {
    if (!net) return;
    net.sendToHost({ type: "PING" });
    if (now() - lastHostMsg > HOST_LOST_MS) {
      toast("방장과 연결이 끊겼습니다");
      leave();
    }
  }
  /** 방을 나간다. quiet면 화면을 바꾸지 않는다(새 방에 들어가기 전 정리). */
  function leave(quiet) {
    if (net) {
      try {
        if (isHost && room) net.broadcastFromHost({ type: "STATE_SYNC", state: { ...snapshot(), phase: "closed" } });
        else net.sendToHost({ type: "LEAVE" });
      } catch (e) {
        /* 이미 끊긴 연결 */
      }
      net.disconnect();
    }
    net = null;
    clearInterval(hostLoop);
    clearInterval(pingTimer);
    cancelAnimationFrame(rafId);
    hostLoop = pingTimer = rafId = null;
    lastSeen.clear();
    room = null;
    shownKey = "";
    M.active = false;
    $("screen-play").classList.remove("multi", "reveal", "name", "place");
    for (const id of ["board", "btn-confirm", "hud-room"]) $(id).classList.add("hidden");
    if (!quiet) A.show("screen-home");
  }
  function again() {
    if (isHost && room) startRound();
  }

  /* ---------- 상태 받아 그리기 ---------- */
  function applyState(state, fromSelf) {
    if (!fromSelf) room = state;
    localEnds = now() + (state.left || 0);
    if (state.phase === "closed") {
      toast("방장이 방을 닫았습니다");
      return leave();
    }
    const key = `${state.phase}:${state.qi}`;
    if (key !== shownKey) {
      shownKey = key;
      enterPhase(state.phase);
    }
    renderPeople();
  }

  function enterPhase(phase) {
    const play = $("screen-play");
    $("hud-room").textContent = `방 ${room.code}`;
    $("hud-room").classList.remove("hidden");
    if (phase === "lobby") return showLobby();
    if (phase === "final") return showFinal();
    A.show("screen-play");
    play.classList.add("multi");
    play.classList.toggle("name", phase === "name" || phase === "nameReveal");
    play.classList.toggle("place", phase === "place" || phase === "placeReveal");
    play.classList.toggle("reveal", phase === "nameReveal" || phase === "placeReveal");
    $("board").classList.remove("hidden");
    $("btn-next").classList.add("hidden");
    $("hud-q").textContent = `${room.qi + 1} / ${room.codes.length}`;
    const c = country();
    const spectating = me() && me().spectating;
    if (phase === "name") {
      myName = myPlace = pin = null;
      A.clearMapFx();
      A.resetView();
      $("flag").src = `primary_data/flags/${c.code}.svg`;
      $("stage").textContent = "1단계 · 나라 이름";
      $("ask").textContent = "이 국기의 나라는?";
      $("name-form").classList.remove("hidden");
      $("btn-confirm").classList.add("hidden");
      const input = $("name-in");
      input.value = "";
      input.disabled = spectating;
      A.feedback("", spectating ? "구경 중 · 다음 판부터 참가합니다" : "");
      if (!spectating) input.focus();
    } else if (phase === "nameReveal") {
      $("name-in").disabled = true;
      $("name-in").blur();
      $("name-form").classList.add("hidden");
      const a = ansOf(myId).name;
      if (spectating || !a) A.feedback("", `정답은 ${c.name}`);
      else if (a.ok) A.feedback("ok", `정답! +${a.score}`, c.name);
      else A.feedback("no", myName ? "아쉬워요" : "시간 끝!", `정답은 ${c.name}`);
    } else if (phase === "place") {
      $("stage").textContent = "2단계 · 지도에서 찾기";
      $("ask").innerHTML = `지도에서 <b>${c.name}</b>${A.objParticle(c.name)} 누르세요`;
      A.feedback("", spectating ? "구경 중" : "", spectating ? "" : "핀을 놓고 「확정」을 누르세요. 다시 누르면 핀이 옮겨집니다.");
      if (window.matchMedia("(max-width: 820px)").matches) $("mapcard").scrollIntoView({ behavior: "smooth", block: "end" });
    } else if (phase === "placeReveal") {
      $("btn-confirm").classList.add("hidden");
      drawReveal(c);
    }
    stageStartLocal = localEnds - LIMIT[phase];
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }

  function tick() {
    if (!room || !PLAY_PHASES.includes(room.phase)) return;
    const left = Math.max(0, localEnds - now());
    const ratio = left / LIMIT[room.phase];
    const bar = $("timer-bar");
    bar.style.width = ratio * 100 + "%";
    const answering = room.phase === "name" || room.phase === "place";
    bar.classList.toggle("low", answering && ratio < 0.3);
    bar.classList.toggle("rest", !answering);
    // 시간이 끝났는데 핀만 놓고 확정을 안 눌렀으면 놓인 핀으로 낸다
    if (left <= 0 && room.phase === "place" && pin && !myPlace) confirmPin();
    rafId = requestAnimationFrame(tick);
  }

  /* ---------- 내 입력 ---------- */
  function canAnswer(phase) {
    return M.active && room && room.phase === phase && me() && !me().spectating;
  }
  function submitName(value) {
    if (!canAnswer("name") || myName) return;
    const c = country();
    const ok = Boolean(value) && E.checkName(value, c);
    const score = E.nameScore(ok, now() - stageStartLocal);
    myName = { ok, score };
    net.sendToHost({ type: "NAME", qi: room.qi, ok, score });
    $("name-in").disabled = true;
    $("name-in").blur();
    if (ok) A.feedback("ok", `정답! +${score}`, "다른 사람을 기다리는 중");
    else A.feedback("no", value ? "아쉬워요" : "넘겼어요", "다른 사람을 기다리는 중");
  }

  function onMapTap(tap) {
    if (!canAnswer("place") || myPlace) return;
    pin = { xy: tap.xy, hitCode: tap.path ? tap.path.getAttribute("data-c") : null, pxPerUnit: A.pxPerUnit(), at: now() };
    const r = A.svg.viewBox.baseVal.width / 90;
    A.fx.innerHTML = `<circle class="pin me" cx="${pin.xy[0]}" cy="${pin.xy[1]}" r="${r}"/>`;
    $("btn-confirm").classList.remove("hidden");
  }

  function confirmPin() {
    if (!canAnswer("place") || myPlace || !pin) return;
    const c = country();
    const answerPath = A.svg.querySelector(`path[data-c="${c.code}"]`);
    const res = E.judgePlace({
      hitCode: pin.hitCode,
      answerCode: c.code,
      clickXY: pin.xy,
      pxPerUnit: pin.pxPerUnit,
      answerPoints: E.parsePathPoints(answerPath.getAttribute("d")),
    });
    // 점수 시각은 마지막으로 핀을 놓은 때 (확정을 늦게 눌러도 손해 없음)
    const score = E.placeScore(res, pin.at - stageStartLocal, LIMIT.place);
    const km = res.correct ? 0 : res.km;
    myPlace = { ok: res.correct, km, score };
    net.sendToHost({ type: "PLACE", qi: room.qi, ok: res.correct, km, score, xy: pin.xy });
    $("btn-confirm").classList.add("hidden");
    A.feedback("", "확정했습니다", "다른 사람을 기다리는 중");
  }

  /** 정답 나라를 칠하고 모두의 핀을 닉네임과 함께 찍는다. */
  function drawReveal(c) {
    A.clearMapFx();
    const answerPath = A.svg.querySelector(`path[data-c="${c.code}"]`);
    answerPath.classList.add("answer");
    A.svg.querySelector(`circle[data-m="${c.code}"]`).classList.add("on");
    const b = answerPath.getBBox();
    let x0 = b.x;
    let y0 = b.y;
    let x1 = b.x + b.width;
    let y1 = b.y + b.height;
    const pins = [];
    for (const [uid, p] of Object.entries(room.players)) {
      const a = ansOf(uid).place;
      if (!a || !a.xy) continue;
      pins.push({ uid, nick: p.nick, xy: a.xy });
      x0 = Math.min(x0, a.xy[0]);
      y0 = Math.min(y0, a.xy[1]);
      x1 = Math.max(x1, a.xy[0]);
      y1 = Math.max(y1, a.xy[1]);
    }
    A.fitTo({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    const fs = A.svg.viewBox.baseVal.width / 45;
    A.fx.innerHTML = pins
      .map(
        (q) =>
          `<circle class="pin${q.uid === myId ? " me" : ""}" cx="${q.xy[0]}" cy="${q.xy[1]}" r="${fs / 3}"/>` +
          `<text x="${q.xy[0]}" y="${q.xy[1] - fs / 2}" font-size="${fs}" text-anchor="middle">${esc(q.nick)}</text>`
      )
      .join("");
    const a = ansOf(myId).place;
    if (!a || (me() && me().spectating)) A.feedback("", c.name, c.where);
    else if (a.ok) A.feedback("ok", `찾았어요! +${a.score}`, c.where);
    else if (a.km == null) A.feedback("no", "시간 끝!", c.where);
    else A.feedback("no", `약 ${a.km.toLocaleString()}km 빗나감${a.score ? ` +${a.score}` : ""}`, c.where);
  }

  /* ---------- 대기실·점수판·결과 ---------- */
  function ranked() {
    // 방장의 정본에는 away가 없어서 직접 계산한다 (참가자는 받은 사본의 away를 쓴다)
    return E.rankPlayers(Object.entries(room.players).map(([uid, p]) => ({ uid, ...p, away: isHost ? isAway(uid) : p.away })));
  }
  function statusOf(uid, p) {
    if (p.away) return '<span class="x">연결 끊김</span>';
    if (p.spectating) return "구경 중";
    const a = ansOf(uid);
    switch (room.phase) {
      case "name":
        return a.name ? "답함" : "…";
      case "nameReveal":
        return a.name && a.name.ok ? `<span class="o">+${a.name.score}</span>` : '<span class="x">✗</span>';
      case "place":
        return a.place ? "확정" : "…";
      case "placeReveal":
        if (!a.place) return "";
        if (a.place.ok) return `<span class="o">+${a.place.score}</span>`;
        if (a.place.km == null) return '<span class="x">✗</span>';
        return `<span class="x">${a.place.km.toLocaleString()}km</span>${a.place.score ? ` +${a.place.score}` : ""}`;
      default:
        return "";
    }
  }
  function personRow(uid, p, extra) {
    return (
      `<li class="${uid === myId ? "me" : ""}"><span class="nm">${esc(p.nick)}${p.isHost ? ' <small>방장</small>' : ""}</span>` +
      `<span class="st">${extra}</span></li>`
    );
  }
  function renderPeople() {
    if (!room) return;
    const mine = me();
    $("hud-score").textContent = mine ? mine.total : 0;
    if (room.phase === "lobby") {
      const list = ranked();
      $("lobby-count").textContent = `참가자 ${list.length}명`;
      $("lobby-people").innerHTML = list.map((p) => personRow(p.uid, p, p.away ? '<span class="x">연결 끊김</span>' : "")).join("");
    } else if (PLAY_PHASES.includes(room.phase)) {
      $("board-list").innerHTML = ranked()
        .map((p) => personRow(p.uid, p, `${statusOf(p.uid, p)} <b>${p.total}</b>`))
        .join("");
    }
  }
  function showLobby() {
    cancelAnimationFrame(rafId);
    A.show("screen-lobby");
    $("hud").classList.add("hidden");
    $("lobby-code").textContent = room.code;
    $("btn-mp-start").classList.toggle("hidden", !isHost);
    $("lobby-wait").classList.toggle("hidden", isHost);
  }
  function showFinal() {
    cancelAnimationFrame(rafId);
    const list = ranked().filter((p) => !p.spectating);
    const myRank = list.findIndex((p) => p.uid === myId) + 1;
    const mine = me();
    $("r-total").textContent = mine ? mine.total : 0;
    $("r-max").textContent = ` / ${room.codes.length * 200}`;
    $("r-best").textContent = myRank ? `${list.length}명 중 ${myRank}등` : "구경했습니다";
    let prev = null;
    let place = 0;
    $("r-rank").innerHTML = list
      .map((p, i) => {
        if (!prev || p.total !== prev.total) place = i + 1;
        prev = p;
        return personRow(p.uid, p, `<span class="sub">${place}등 · 이름 ${p.nameHits} · 위치 ${p.placeHits}</span> <b>${p.total}</b>`);
      })
      .join("");
    for (const id of ["r-stats", "r-missed-title", "r-missed"]) $(id).classList.add("hidden");
    $("r-rank").classList.remove("hidden");
    $("btn-again").classList.toggle("hidden", !isHost);
    $("r-wait").classList.toggle("hidden", isHost);
    $("btn-r-leave").classList.remove("hidden");
    A.show("screen-result");
  }

  /* ---------- 버튼 ---------- */
  $("btn-create").onclick = create;
  $("btn-join").onclick = join;
  $("mp-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) join();
  });
  $("btn-mp-start").onclick = () => isHost && room && room.phase === "lobby" && startRound();
  $("btn-confirm").onclick = confirmPin;
  $("btn-leave").onclick = () => leave();
  $("btn-r-leave").onclick = () => leave();
  $("btn-copy").onclick = async () => {
    const url = `${location.origin}${location.pathname}?room=${room.code}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("초대 링크를 복사했습니다");
    } catch (e) {
      toast(url);
    }
  };
  window.addEventListener("pagehide", () => {
    if (M.active) leave(true);
  });

  try {
    $("mp-nick").value = localStorage.getItem(NICK_KEY) || "";
  } catch (e) {
    /* 기록 없이 진행 */
  }
  const roomParam = new URLSearchParams(location.search).get("room");
  if (roomParam) {
    $("mp-code").value = roomParam.toUpperCase().slice(0, 5);
    document.querySelector(".together").scrollIntoView({ block: "center" });
    $("mp-nick").focus({ preventScroll: true });
  }
  if (!window.RoomNetwork || (!window.mqtt && !window.Peer)) {
    for (const id of ["btn-create", "btn-join"]) $(id).disabled = true;
    alertHome("멀티플레이 중계 라이브러리를 불러오지 못했습니다. 혼자 하기는 됩니다.");
  }
})();
