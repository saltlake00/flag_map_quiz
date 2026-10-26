# 국기·지도 찾기 (Flag & Map Quiz)

국기를 보고 나라 이름을 쓰고, 이어서 세계 지도에서 그 나라를 눌러 위치를 찾는 혼자 하는 웹 미니게임입니다.
[추상화 그림맞추기](https://github.com/saltlake00/abstract_quiz)와 같은 손맛(빨리 맞힐수록 높은 점수, 오타 허용 채점, 즉시 피드백, 어두운 갤러리 테마)을 따릅니다.

* **라이브 배포 주소**: `https://saltlake00.github.io/flag_map_quiz/`
* **저장소 주소**: `https://github.com/saltlake00/flag_map_quiz`

## 1. 규칙
* 한 판 = 국기 10개 (나라 39개 중 무작위).
* **1단계 · 나라 이름** (15초): 국기를 보고 이름을 씁니다. 별칭(예: 미합중국)·띄어쓰기·가운뎃점은 무시하고, 5글자 이상 이름은 한 글자 오타를 봐줍니다.
* **2단계 · 지도에서 찾기** (20초): 지도에서 그 나라를 누릅니다.
  * 나라 안을 누르면 정답. 경계 바로 바깥도 화면 24px·실제 400km 안이면 정답(작은 나라·섬). 다른 출제 나라를 눌렀으면 오답.
  * 틀리면 정답 나라를 칠하고, 누른 곳에서 정답 경계까지 대략 거리(km)를 보여 줍니다. 2,000km 안이면 가까운 만큼 최대 40점.
* 점수: 단계마다 바로 맞히면 100점, 제한 시간 끝에 맞히면 20점 (abstract_quiz와 같은 곡선). 한 판 최대 2,000점.
* 판이 끝나면 총점, 이름·위치 맞힌 수, 틀린 나라 목록. 최고 기록은 이 브라우저의 localStorage(`flagmap.v1`)에만 남습니다.
* 지도는 ＋/－/⟲ 버튼, 마우스 휠, 두 손가락으로 확대하고 끌어서 이동합니다. 휴대폰에서는 작은 나라를 확대해서 누릅니다.

## 2. 폴더 구조
* `primary_data/` : 원본 자료 (daily-study 「배우기」 탭에서 복사)
  * `world.toml` 나라 39개(이름·별칭·대륙·위치 설명), `countries-110m.json` 세계 지도(world-atlas 2.0.2, Natural Earth 1:110m), `flags/` 국기(flag-icons 7.2.3, MIT)
* `scripts/build_data.py` : 나라 목록과 지도를 `data/world.js`로 묶습니다 (TopoJSON → SVG 경로, 등장방형 투영).
* `data/world.js` : 자동 생성. 직접 고치지 않습니다.
* `js/engine.js` : 화면과 무관한 규칙(채점·좌표 변환·거리·지도 판정·점수). node와 브라우저 둘 다에서 돕니다.
* `js/app.js` : 화면 전환, 타이머, 지도 확대/이동/누르기.
* `tests/engine.test.js` : 엔진 시험.

## 3. 로컬 실행과 검증
```powershell
python -X utf8 scripts/build_data.py   # primary_data를 바꿨을 때만
python -m http.server 8800             # http://localhost:8800
node --test tests/engine.test.js
```

나라를 더하려면 `primary_data/world.toml`에 `[[country]]`를 더하고(`code`·`num`은 ISO 3166-1), 국기 SVG를 `primary_data/flags/`에 넣은 뒤 빌드합니다.
