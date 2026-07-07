# qoo10-megapo-tracker

Qoo10 Japan メガポ 이벤트 자동 기록 (GitHub Actions).

## 수집 내용

- **매시간 :05 (JST)** — 리얼타임 랭킹 1~100위 → `data/cumulative.csv`에 누적 (날짜/시간/순위/상품코드/상품명/표시가 + 샵·브랜드·참고가·판매가·타임세일가·메가포쿠폰·메가포인트 + 순위변동). 원본 HTML은 `data/html/*.html.gz`
- **매일 09:30 JST** — 이벤트 메인 페이지(sid=1422) 전체 스크린샷 → `data/screenshots/*.jpg`
- **워치리스트** — `watch_goodscodes.txt`의 상품코드가 랭킹에 있으면 매시간 랭킹 페이지 스크린샷 추가 저장

샵·브랜드·가격 상세는 상품 페이지를 방문해 수집하며, 부하를 줄이기 위해 상품별 3시간 캐시(`data/product_cache.json`)를 사용.

## 운영

- 수동 실행: Actions 탭 → "Qoo10 Megapo Capture" → Run workflow (mode: `ranking` / `screenshot`)
- 워치리스트 수정: GitHub 웹에서 `watch_goodscodes.txt` 편집 (한 줄에 코드 1개)
- **이벤트 종료 후 Actions 탭에서 워크플로 Disable 필수** (무료 실행시간 절약)
- 다음 메가포 때 sid가 바뀌면 `scripts/capture.mjs` 상단 URL 두 곳 수정

## 참고

- GitHub cron은 정시에서 수 분~수십 분 지연될 수 있음
- 대상: sid=22 (랭킹), sid=1422 (이벤트 메인)
