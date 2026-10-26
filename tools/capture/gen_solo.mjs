// 혼자 하기 세 방식 끝까지 돌리는 계획을 만든다
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const OUT = path.join(os.homedir(), "Pictures", "글감", "flag-map-quiz") + "/";
const URL = "http://localhost:8800/";
const CODE = "document.getElementById('flag').src.match(/flags\\/(\\w+)\\.svg/)[1]";
const name = (ok) => `(()=>{const c=WORLD.find(x=>x.code===${CODE});const i=document.getElementById('name-in');i.value=${ok}?c.name:'틀림';document.getElementById('name-form').requestSubmit();return c.name})()`;
const tapRight = `(()=>{const svg=document.querySelector('.wmap');const m=svg.querySelector('circle[data-m="'+${CODE}+'"]');const p=svg.createSVGPoint();p.x=m.cx.baseVal.value;p.y=m.cy.baseVal.value;const q=p.matrixTransform(svg.getScreenCTM());return [q.x,q.y]})()`;
const tapWrong = `(()=>{const r=document.getElementById('map-wrap').getBoundingClientRect();return [r.x+r.width*0.45,r.y+r.height*0.97]})()`;
const state = `({total:document.getElementById('r-total').textContent,max:document.getElementById('r-max').textContent,best:document.getElementById('r-best').textContent,title:document.getElementById('r-title').textContent,review:document.querySelectorAll('#r-review li').length,bad:document.querySelectorAll('#r-review li.bad').length,stats:[...document.querySelectorAll('#r-stats > div')].map(d=>d.className+':'+d.textContent),store:localStorage.getItem('flagmap.v1'),screen:[...document.querySelectorAll('main > section')].find(s=>!s.classList.contains('hidden')).id})`;

const plan = [];
function round(tab, mode, shots, mobile) {
  plan.push({ tab, op: "eval", js: `document.querySelector('#mode-solo [data-mode=${mode}]').click();document.getElementById('btn-start').click()` });
  plan.push({ op: "sleep", ms: 400 });
  for (let i = 0; i < 10; i++) {
    if (mode !== "place") {
      if (shots[`n${i}`]) plan.push({ tab, op: "shot", file: OUT + shots[`n${i}`] });
      plan.push({ tab, op: "eval", js: name(i % 3 !== 2) });
      plan.push({ op: "sleep", ms: mode === "both" ? 1300 : 400 });
      if (shots[`nr${i}`]) plan.push({ tab, op: "shot", file: OUT + shots[`nr${i}`] });
    }
    if (mode !== "name") {
      if (shots[`p${i}`]) plan.push({ tab, op: "shot", file: OUT + shots[`p${i}`] });
      plan.push({ tab, op: "tapjs", js: i % 2 === 0 ? tapRight : tapWrong, touch: mobile });
      plan.push({ op: "sleep", ms: 500 });
      if (shots[`pr${i}`]) plan.push({ tab, op: "shot", file: OUT + shots[`pr${i}`] });
    }
    plan.push({ tab, op: "eval", js: "document.getElementById('btn-next').click()" });
    plan.push({ op: "sleep", ms: 300 });
  }
  plan.push({ tab, op: "eval", js: state, print: true });
  if (shots.result) plan.push({ tab, op: "shot", file: OUT + shots.result, full: true });
}

// 데스크톱: 옛 기록 옮김 확인 + 이름+위치
plan.push({ tab: "d", op: "open", url: URL, w: 1280, h: 860 });
plan.push({ tab: "d", op: "eval", js: "localStorage.setItem('flagmap.v1',JSON.stringify({best:1542,plays:3}));location.reload()" });
plan.push({ op: "sleep", ms: 1200 });
plan.push({ tab: "d", op: "eval", js: "document.getElementById('home-best').textContent", print: true });
plan.push({ tab: "d", op: "shot", file: OUT + "개편-수정후-01-데스크톱-처음.jpg" });
round("d", "both", { n0: "개편-수정후-02-데스크톱-이름단계.jpg", pr1: "개편-수정후-03-데스크톱-위치오답.jpg", result: "개편-수정후-04-데스크톱-결과.jpg" }, false);

// 모바일: 이름만, 위치만
plan.push({ tab: "m", op: "open", url: URL, w: 390, h: 844, mobile: true });
plan.push({ tab: "m", op: "shot", file: OUT + "개편-수정후-05-모바일-처음.jpg" });
round("m", "name", { nr0: "개편-수정후-06-모바일-이름만-정답.jpg", result: "개편-수정후-07-모바일-이름만-결과.jpg" }, true);
plan.push({ tab: "m", op: "eval", js: "document.getElementById('btn-home').click()" });
round("m", "place", { p0: "개편-수정후-08-모바일-위치만.jpg", pr0: "개편-수정후-09-모바일-위치만-정답.jpg" }, true);
plan.push({ tab: "m", op: "eval", js: "document.getElementById('btn-home').click();document.getElementById('home-best').textContent", print: true });
// 나가기 두 번 누르기
plan.push({ tab: "m", op: "eval", js: "document.getElementById('btn-start').click();document.getElementById('btn-quit').click();document.getElementById('btn-quit').textContent", print: true });
plan.push({ tab: "m", op: "shot", file: OUT + "개편-수정후-10-모바일-나가기확인.jpg" });
plan.push({ tab: "m", op: "eval", js: "document.getElementById('btn-quit').click();[...document.querySelectorAll('main > section')].find(s=>!s.classList.contains('hidden')).id", print: true });
fs.writeFileSync(process.argv[2], JSON.stringify(plan, null, 1));
