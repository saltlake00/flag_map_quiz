// 실행: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const E = require("../js/engine.js");

function loadWorld() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "data", "world.js"), "utf8"), sandbox);
  return sandbox.window;
}

test("이름 채점: 별칭·띄어쓰기·가운뎃점 무시", () => {
  const us = { name: "미국", alias: ["미합중국", "아메리카"] };
  assert.ok(E.checkName("미국", us));
  assert.ok(E.checkName(" 미 합중국 ", us));
  assert.ok(E.checkName("아메리카", us));
  assert.ok(!E.checkName("캐나다", us));
  assert.ok(!E.checkName("", us));
  const za = { name: "남아프리카 공화국", alias: ["남아공"] };
  assert.ok(E.checkName("남아프리카·공화국", za));
  assert.ok(E.checkName("남아공", za));
});

test("이름 채점: 5글자 이상만 한 글자 오타 허용", () => {
  const ph = { name: "필리핀", alias: [] };
  assert.ok(!E.checkName("필리팡", ph)); // 3글자는 정확히
  const nz = { name: "뉴질랜드", alias: [] };
  assert.ok(!E.checkName("뉴질랜두", nz)); // 4글자도 정확히
  const sa = { name: "사우디아라비아", alias: [] };
  assert.ok(E.checkName("사우디아라바아", sa));
  assert.ok(!E.checkName("사우디아라", sa));
});

test("좌표 변환과 거리", () => {
  const p = E.toLonLat(500, 233.3333);
  assert.ok(Math.abs(p.lon) < 1e-6 && Math.abs(p.lat) < 0.01);
  // 서울(37.57, 126.98) ↔ 도쿄(35.68, 139.69) 약 1,150km
  const km = E.haversineKm({ lat: 37.57, lon: 126.98 }, { lat: 35.68, lon: 139.69 });
  assert.ok(km > 1100 && km < 1200, km);
});

test("경로 꼭짓점 읽기", () => {
  assert.deepEqual(E.parsePathPoints("M1.5 2L3 -4.25ZM5 6Z"), [[1.5, 2], [3, -4.25], [5, 6]]);
});

test("지도 판정: 경로 안·경계 근처·다른 출제 나라", () => {
  // 정답 경계: 지도 (100,100)~(110,110) 근처. 지도 1단위 ≈ 위도 0.36° ≈ 40km
  const pts = [[100, 100], [110, 100], [110, 110]];
  assert.equal(E.judgePlace({ hitCode: "kr", answerCode: "kr", clickXY: [0, 0], pxPerUnit: 1, answerPoints: pts }).correct, true);
  // 경계에서 3단위(≈120km), 확대해서 1단위=5px → 15px: 인정
  const near = E.judgePlace({ hitCode: null, answerCode: "il", clickXY: [113, 100], pxPerUnit: 5, answerPoints: pts });
  assert.ok(near.correct && near.byNear);
  // 같은 3단위라도 다른 출제 나라를 눌렀으면 오답
  const other = E.judgePlace({ hitCode: "jp", answerCode: "il", clickXY: [113, 100], pxPerUnit: 5, answerPoints: pts });
  assert.ok(!other.correct && other.km > 0);
  // 휴대폰 전체 보기(1단위=0.34px): 20단위(≈800km)는 화면으로 7px뿐이지만 400km를 넘어 오답
  const phone = E.judgePlace({ hitCode: null, answerCode: "il", clickXY: [130, 100], pxPerUnit: 0.34, answerPoints: pts });
  assert.ok(!phone.correct);
  // 화면으로 멀면(10단위×5px=50px) 오답
  const far = E.judgePlace({ hitCode: null, answerCode: "il", clickXY: [120, 100], pxPerUnit: 5, answerPoints: pts });
  assert.ok(!far.correct);
});

test("점수: 시간 곡선과 가까운 오답 부분 점수", () => {
  assert.equal(E.timeScore(0, 15000), 100);
  assert.equal(E.timeScore(15000, 15000), 20);
  assert.equal(E.timeScore(99999, 15000), 20);
  assert.equal(E.nameScore(false, 0), 0);
  assert.equal(E.placeScore({ correct: false, km: 0 }, 0), 40);
  assert.equal(E.placeScore({ correct: false, km: 1000 }, 0), 20);
  assert.equal(E.placeScore({ correct: false, km: 5000 }, 0), 0);
  assert.equal(E.placeScore({ correct: false, km: Infinity }, 0), 0);
});

test("문제 뽑기: 겹치지 않고 n개", () => {
  const list = Array.from({ length: 39 }, (_, i) => i);
  let seed = 1;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const r = E.pickRound(list, 10, rng);
  assert.equal(r.length, 10);
  assert.equal(new Set(r).size, 10);
  assert.equal(E.pickRound([1, 2], 10).length, 2);
});

test("요약", () => {
  const s = E.summarize([
    { country: { code: "kr" }, nameOk: true, placeOk: true, km: 0, nameScore: 100, placeScore: 80 },
    { country: { code: "il" }, nameOk: true, placeOk: false, km: 900, nameScore: 50, placeScore: 22 },
  ]);
  assert.equal(s.total, 252);
  assert.equal(s.max, 400);
  assert.equal(s.nameHits, 2);
  assert.equal(s.placeHits, 1);
  assert.deepEqual(s.missed.map((r) => r.country.code), ["il"]);
});

test("자료: 나라마다 국기·지도 경로·표식 원이 있다", () => {
  const w = loadWorld();
  assert.ok(w.WORLD.length >= 30);
  const root = path.join(__dirname, "..");
  for (const c of w.WORLD) {
    assert.ok(fs.existsSync(path.join(root, "primary_data", "flags", `${c.code}.svg`)), c.code);
    assert.ok(w.MAP_SVG.includes(`data-c="${c.code}"`), `경로 ${c.code}`);
    assert.ok(w.MAP_SVG.includes(`data-m="${c.code}"`), `표식 ${c.code}`);
  }
});
