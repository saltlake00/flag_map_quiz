# 인계 — 멀티모드·UI/UX 개편과 출제 방식 선택 (2026-10-26)

## 진행 상태 (2026-10-26 두 번째 세션 끝, 다른 PC에서 이어 하기)

**브랜치 `feat/uiux-개편`에 push했다. main(=배포본)에는 아직 안 올렸다.** 멀티를 끝까지 확인하지 못해서다.

### 정한 것 (사용자 답)

* 출제 방식은 **세 갈래 선택**(이름 + 위치 / 이름만 / 위치만). 체크박스 두 개가 아님.
* UI/UX는 **처음 화면·대기실·게임 중·결과 네 곳 모두**.
* 문구는 **드라이하게, 웹 멀티게임(사과게임 등)처럼**: 싱글·멀티 탭, 방 생성, 방 입장·입장, 게임 시작, 방장 시작 대기 중, 초대 링크, 다시 하기, 대기실로, 메인으로. 「친구와 같이」 같은 말투는 쓰지 않는다.

### 만든 것

* `js/engine.js`: `MODES`·`normalizeMode`·`modeStages`·`maxScore(mode, n)`, `summarize(results, mode)`(틀린 문제는 푼 단계만), `normalizeStore`·`recordBest`(최고 기록 방식별 `{best:{both,name,place}, plays}`, 옛 숫자 기록은 both로).
* `js/app.js`: 처음 화면 탭, 출제 방식 고르기(`flagmap.mode`에 기억), 방식별 흐름(위치만은 이름 단계 건너뜀, 이름만은 답 뒤 지도에 정답 칠하고 「다음」), 타이머 남은 초, 「나가기」 두 번 누르기(3초), 결과 「문제별 결과」(혼자·멀티 공용 `showResult`).
* `js/multi.js`: `room.mode`(방장이 대기실에서 고름, 참가자는 보기만), 방식별 단계 전환, 이름만은 이름 결과 4초+지도 표시, 결과에 내 문제별 결과(`myHist`), 방장 「대기실로」, 폰은 초대 링크를 공유 시트로.
* `style.css`: 탭·세 칸 선택·대기실 배치, 폰 점수판을 맨 위 한 줄 칩으로(지도 단계에서도 보임), 폰 게임 칸 넘침 고침(`minmax(0,1fr)`, 개편 전부터 있던 버그).
* `index.html`: `?v=20261026c`로 올림. 문서: README §1, `docs/멀티플레이-규칙.md` §1·§2·§2.1.
* 시험 `node --test tests/engine.test.js` **15개 통과**(3개 추가).

### 확인한 것 / 못 한 것

* 확인함(헤드리스 Chrome 자동 플레이): 싱글 세 방식 모두 10문제 끝까지, 만점 2,000/1,000/1,000, 방식별 최고 기록·옛 기록 옮김, 「나가기」 두 번. 멀티는 방 생성 → 초대 링크로 입장(MQTT만) → 대기실 방식 동기화(참가자 버튼 잠김) → 첫 문제 이름 단계까지.
* **못 함**: 멀티 지도 단계부터 끝까지(세 방식), 멀티 결과 화면, 문구 바꾼 뒤 화면, 배포본 확인, 실기기(폰 둘).
  * 멈춘 이유는 앱이 아니라 시험 도구였다: 헤드리스 Chrome에서 뒤에 가려진 탭에 터치 입력을 보내면 끝없이 기다린다. `tools/capture/cap.mjs`에 `Page.bringToFront`와 백그라운드 억제 끄기 옵션을 넣었지만 **고친 판은 아직 돌려 보지 않았다.**

### 다음 액션

1. `python -m http.server 8800`(저장소 폴더) 또는 위키 launch.json `flag-map-quiz`로 서버를 띄운다.
2. 멀티 자동 시험: `cd tools/capture && node gen_multi.mjs multi.json && node cap.mjs multi.json` (약 4분, 백그라운드로). 캡처는 `~/Pictures/글감/flag-map-quiz/개편-수정후-11~20`. `[a]/[b] "timeout: …"` 줄이 나오면 그 단계가 안 넘어간 것.
   * 싱글 다시 찍기: `node gen_solo.mjs solo.json && node cap.mjs solo.json` (문구 바꾼 뒤 판으로 01~10을 다시 찍는다).
   * `cap.mjs`는 Chrome 경로를 `C:/Program Files/Google/Chrome/Application/chrome.exe`로 고정해 두었다.
3. 캡처를 눈으로 본다(특히 폰 점수판 칩, 대기실, 멀티 결과).
4. 통과하면 `feat/uiux-개편`을 main에 병합 → push → 1~2분 뒤 https://saltlake00.github.io/flag_map_quiz/ 에서 새 화면(싱글/멀티 탭)이 보이는지 확인. 파일을 또 고치면 `?v=` 판 번호를 모두 같이 올린다.
5. 끝나면 이 문서 머리를 「끝」으로 바꾸고, 위키 `projects/자기계발/교양학습-도구/HANDOFF.md` 1-6 줄을 고친다.

캡처: 고치기 전 `개편-수정전-01~05`, 고친 뒤 `개편-수정후-01~14`(01~10은 문구 바꾸기 전 판). 다른 PC에는 이 캡처가 없다(`~/Pictures`는 PC마다 따로).

---

아래는 첫 인계 원문이다.

이전 세션이 길어져(컨텍스트 약 28만) 새 세션으로 넘긴다. 이 문서만 읽고 시작한다.

## 요청 (사용자 원문)

> 멀티모드랑 uiux 개편좀해줘. 시작할때 국기이름이랑 위치 연속으로 할지, 둘중 하나씩 각각 할지도 체크하게 해주고

## 해석과 먼저 물을 것

1. **출제 방식 선택 (분명한 요구)**: 시작할 때 고른다.
   * 이름 + 위치 (지금 방식, 한 문제 = 이름 단계 → 위치 단계)
   * 이름만 (국기 보고 이름만)
   * 위치만 (나라 이름을 보여 주고 지도에서 찾기만)
   * 혼자 하기와 멀티 둘 다. 멀티는 **방장이 대기실에서** 고르고 모두에게 같은 방식이 적용된다(방 상태 `room.mode`).
   * 점수 만점이 바뀐다: 이름+위치 2,000 / 하나만 1,000. 최고 기록(localStorage `flagmap.v1`)은 방식별로 따로 둔다.
   * "체크하게" → 체크박스 두 개(이름 ☑, 위치 ☑, 둘 다 끌 수는 없음)인지 세 갈래 선택인지 사용자에게 확인. 체크박스 두 개면 표현이 자연스럽다.
2. **「멀티모드·UI/UX 개편」은 범위가 열려 있다.** 바로 만들지 말고 무엇이 불편했는지 먼저 묻는다. 후보:
   * 처음 화면: 혼자/같이 두 갈래가 한 카드에 세로로 길게 쌓여 있음(폰에서 「같이」가 화면 아래). 탭이나 두 카드로 나누기.
   * 대기실: 출제 방식·문제 수 설정, 참가자 목록, 시작 버튼 위계.
   * 게임 중: 점수판 위치(폰에서 지도 아래), 「나가기」 없음, 타이머가 얇은 막대뿐(남은 초 숫자 없음).
   * 결과: 문제별 내 답 다시 보기가 멀티에서 빠져 있음.
   * 디자인 기준은 위키 `projects/gamedev/개인프로젝트/UI-목업-검수-체크리스트.md`(마디아 영상 정리). 이미 한 번 적용함(`6ae2e46`).
   * 시안이 필요하면 작업 습관 「UI 목업은 캔버스 + 저장소 사본」을 따른다.

## 현재 상태

* 레포 `~/Documents/GitHub/flag_map_quiz` (공개 `saltlake00/flag_map_quiz`), main 브랜치, 배포 GitHub Pages https://saltlake00.github.io/flag_map_quiz/ (푸시 후 1~2분).
* 최근 커밋: `ecb4173` 캐시 판 번호, `7634f74` 멀티플레이, `6ae2e46` 디자인 정리·폰 지도 확대, `7b6294b` 멀티 규칙 문서.
* 파일
  * `js/engine.js` 규칙(node·브라우저 공용). `NAME_LIMIT_MS` 15초, `PLACE_LIMIT_MS` 20초, `MULTI_PLACE_LIMIT_MS` 25초, `placeScore(res, elapsed, limit)`, `rankPlayers`, `hashRoomPassword`, `generateRoomCode`.
  * `js/app.js` 혼자 하기와 지도 도구. `window.FlagApp`으로 지도 도구를 내놓는다. 멀티 중에는 입력을 `window.FlagMulti`로 넘긴다.
  * `js/multi.js` 멀티 진행. 방장 브라우저가 `hostTick`으로 단계(lobby → name → nameReveal → place → placeReveal × 10 → final)를 넘기고 `STATE_SYNC`로 방 상태 전체를 뿌린다. 판정은 각자 브라우저.
  * `js/net.js` abstract_quiz에서 가져온 통신(공개 MQTT·PeerJS·BroadcastChannel). 토픽 이름만 다름. 고치면 abstract_quiz도 같이.
  * `docs/멀티플레이-규칙.md` 정한 규칙과 기본값, 통신 한계.
* 출제 방식을 넣을 때 고칠 곳: app.js `nextQuestion`/`submitName`/`startPlace`(이름만이면 위치 단계 건너뜀, 위치만이면 이름 단계 건너뛰고 나라 이름을 바로 보여 줌), engine `summarize`의 `max`, multi.js `hostTick`의 단계 전환과 `closeStage`, 결과 화면 문구.

## 지킬 것

* `index.html`의 CSS·JS 주소 `?v=판번호`를 고칠 때마다 모두 같이 올린다(안 올리면 Pages 캐시로 옛 JS와 새 JS가 섞여 깨진다. 2026-10-26 실측).
* 시험: `node --test tests/engine.test.js` (지금 12개).
* 확인: 위키 `.claude/launch.json`의 `flag-map-quiz`(8800) 또는 이미 떠 있는 `http://localhost:8800`. 멀티는 탭 두 개, 참가 탭은 `window.BroadcastChannel = undefined` 후 참가(MQTT만 쓰게). 폰 화면은 `resize_window` mobile.
* 캡처는 `~/Pictures/글감/flag-map-quiz/`에 번호를 붙여 저장한다. 고치기 전 화면부터 찍는다.
* 커밋은 파일 단위로 `git add -- 파일`, 한국어 메시지, 끝나면 push.
* 실기기(폰 둘) 시험은 아직 안 했다.
