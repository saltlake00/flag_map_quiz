// 멀티: 방장(a)·참가(b, MQTT만) 두 탭으로 세 방식을 같은 방에서 차례로 끝까지
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const OUT = path.join(os.homedir(), "Pictures", "글감", "flag-map-quiz") + "/";
const URL = "http://localhost:8800/";
const CODE = "document.getElementById('flag').src.match(/flags\\/(\\w+)\\.svg/)[1]";
const wait = (cond, ms = 40000) => `(async()=>{for(let t=0;t<${ms / 100};t++){if(${cond})return true;await new Promise(r=>setTimeout(r,100))}return 'timeout: ${cond.replace(/'/g, "").slice(0, 60)}'})()`;
const play = "document.getElementById('screen-play').classList";
const atQ = (i, kind) => `document.getElementById('hud-q').textContent.startsWith('${i + 1} /')&&${play}.contains('${kind}')&&!${play}.contains('reveal')&&!document.getElementById('screen-play').classList.contains('hidden')`;
const name = (ok) => `(()=>{const c=WORLD.find(x=>x.code===${CODE});const i=document.getElementById('name-in');i.value=${ok}?c.name:'틀림';document.getElementById('name-form').requestSubmit();return c.name})()`;
const tapRight = `(()=>{const svg=document.querySelector('.wmap');const m=svg.querySelector('circle[data-m="'+${CODE}+'"]');const p=svg.createSVGPoint();p.x=m.cx.baseVal.value;p.y=m.cy.baseVal.value;const q=p.matrixTransform(svg.getScreenCTM());const r=document.getElementById('map-wrap').getBoundingClientRect();return [Math.min(r.right-60,Math.max(r.x+5,q.x)),Math.min(r.bottom-5,Math.max(r.y+5,q.y))]})()`;
const resultState = `({title:document.getElementById('r-title').textContent,total:document.getElementById('r-total').textContent,max:document.getElementById('r-max').textContent,best:document.getElementById('r-best').textContent,review:document.querySelectorAll('#r-review li').length,rank:[...document.querySelectorAll('#r-rank li')].map(l=>l.textContent),stats:[...document.querySelectorAll('#r-stats > div')].map(d=>d.className+':'+d.textContent)})`;

const plan = [
  { tab: "a", op: "open", url: URL, w: 390, h: 844, mobile: true },
  { tab: "a", op: "eval", js: "document.getElementById('tab-multi').click();document.getElementById('mp-nick').value='방장';document.getElementById('btn-create').click()" },
  { tab: "a", op: "eval", js: wait("/^[A-Z0-9]{5}$/.test(document.getElementById('lobby-code').textContent)") , print: true },
  { tab: "a", op: "eval", js: "document.getElementById('lobby-code').textContent", save: "code", print: true },
  { tab: "b", op: "open", url: URL + "?room=${code}", w: 390, h: 844, mobile: true, pre: "window.BroadcastChannel = undefined;" },
];
// open의 url에는 변수 치환이 없어서 eval로 다시 연다
plan[4].url = URL;
plan.push({ tab: "b", op: "eval", js: "location.href='" + URL + "?room=${code}'" });
plan.push({ op: "sleep", ms: 1500 });
plan.push({ tab: "b", op: "eval", js: wait("!!window.FlagMulti&&document.readyState==='complete'"), print: true });
plan.push({ tab: "b", op: "shot", file: OUT + "개편-수정후-11-모바일-초대링크로열기.jpg" });
plan.push({ tab: "b", op: "eval", js: "document.getElementById('mp-nick').value='친구';document.getElementById('btn-join').click()" });
plan.push({ tab: "b", op: "eval", js: wait("!document.getElementById('screen-lobby').classList.contains('hidden')"), print: true });
plan.push({ op: "sleep", ms: 1500 });

const modes = [
  { mode: "both", shots: { lobbyA: "개편-수정후-12-모바일-대기실-방장.jpg", lobbyB: "개편-수정후-13-모바일-대기실-참가.jpg", nameB: "개편-수정후-14-모바일-멀티이름.jpg", pinB: "개편-수정후-15-모바일-멀티지도-핀.jpg", revealB: "개편-수정후-16-모바일-멀티지도결과.jpg", finalB: "개편-수정후-17-모바일-멀티결과-참가.jpg", finalA: "개편-수정후-18-모바일-멀티결과-방장.jpg" } },
  { mode: "name", shots: { revealB: "개편-수정후-19-모바일-멀티이름만-결과.jpg" } },
  { mode: "place", shots: { finalB: "개편-수정후-20-모바일-멀티위치만-최종.jpg" } },
];
modes.forEach(({ mode, shots }, k) => {
  if (k > 0) {
    plan.push({ tab: "a", op: "eval", js: "document.getElementById('btn-to-lobby').click()" });
    plan.push({ tab: "b", op: "eval", js: wait("!document.getElementById('screen-lobby').classList.contains('hidden')"), print: true });
  }
  plan.push({ tab: "a", op: "eval", js: `document.querySelector('#mode-lobby [data-mode=${mode}]').click()` });
  plan.push({ tab: "b", op: "eval", js: wait(`document.querySelector('#mode-lobby [data-mode=${mode}]').getAttribute('aria-checked')==='true'`), print: true });
  plan.push({ tab: "b", op: "eval", js: "[...document.querySelectorAll('#mode-lobby button')].map(b=>b.disabled).join()+' | '+document.getElementById('mode-lobby-desc').textContent", print: true });
  if (shots.lobbyA) plan.push({ tab: "a", op: "shot", file: OUT + shots.lobbyA });
  if (shots.lobbyB) plan.push({ tab: "b", op: "shot", file: OUT + shots.lobbyB });
  plan.push({ tab: "a", op: "eval", js: "document.getElementById('btn-mp-start').click()" });
  for (let i = 0; i < 10; i++) {
    if (mode !== "place") {
      for (const t of ["a", "b"]) plan.push({ tab: t, op: "eval", js: wait(atQ(i, "name")), print: true });
      if (i === 0 && shots.nameB) plan.push({ tab: "b", op: "shot", file: OUT + shots.nameB });
      plan.push({ tab: "a", op: "eval", js: name(true) });
      plan.push({ tab: "b", op: "eval", js: name(i % 2 === 0) });
      if (mode === "name" && i === 0 && shots.revealB) {
        plan.push({ tab: "b", op: "eval", js: wait(`${play}.contains('reveal')`), print: true });
        plan.push({ op: "sleep", ms: 600 });
        plan.push({ tab: "b", op: "shot", file: OUT + shots.revealB });
      }
    }
    if (mode !== "name") {
      for (const t of ["a", "b"]) plan.push({ tab: t, op: "eval", js: wait(atQ(i, "place")), print: true });
      plan.push({ op: "sleep", ms: 500 });
      plan.push({ tab: "a", op: "tapjs", js: tapRight, touch: true });
      plan.push({ tab: "b", op: "tapjs", js: tapRight, touch: true });
      if (i === 0 && shots.pinB) plan.push({ tab: "b", op: "shot", file: OUT + shots.pinB });
      for (const t of ["a", "b"]) plan.push({ tab: t, op: "eval", js: "document.getElementById('btn-confirm').click()" });
      if (i === 0 && shots.revealB) {
        plan.push({ tab: "b", op: "eval", js: wait(`${play}.contains('reveal')`), print: true });
        plan.push({ op: "sleep", ms: 800 });
        plan.push({ tab: "b", op: "shot", file: OUT + shots.revealB });
      }
    }
  }
  const fin = "!document.getElementById('screen-result').classList.contains('hidden')";
  for (const t of ["a", "b"]) {
    plan.push({ tab: t, op: "eval", js: wait(fin), print: true });
    plan.push({ tab: t, op: "eval", js: resultState, print: true });
  }
  if (shots.finalB) plan.push({ tab: "b", op: "shot", file: OUT + shots.finalB, full: true });
  if (shots.finalA) plan.push({ tab: "a", op: "shot", file: OUT + shots.finalA });
});
fs.writeFileSync(process.argv[2], JSON.stringify(plan, null, 1));
