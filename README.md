# qoo10-megapo-tracker

Qoo10 Japan 메가포/메가와리 이벤트 자동 기록 (GitHub Actions).

## 수집 스케줄 (이벤트 기간 중, JST 기준)

- **매시간 :45** — 리얼타임 랭킹 1~100위 → `data/cumulative.csv` 누적 (저장일/저장시각/순위/상품코드/상품명/최종가/점포/브랜드/참고가·판매가·타임세일가/쿠폰할인율/포인트/자사상품/순위변동). 원본 HTML은 `data/html/*.html.gz`
- **매일 23:45** — 랭킹 페이지 전체 스크린샷 → `data/screenshots/ranking_realtime_*.jpg`
- **매일 09:30** — 이벤트 메인 페이지 전체 스크린샷 → `data/screenshots/megapo_main_*.jpg`
- **워치리스트** — `watch_list.txt`의 자사 브랜드명(영문/가타카나) 또는 상품코드가 랭킹에 매칭되면 '자사상품' 컬럼 Y + 매시간 랭킹 스크린샷 추가

샵·브랜드·가격 상세는 상품 페이지를 방문해 수집 (상품별 3시간 캐시 `data/product_cache.json`).

## 매 이벤트 운영 (매달 URL 변경됨)

1. `event_config.txt`에서 기간(period)·랭킹 URL·이벤트 URL 세 줄 수정
2. Actions 탭 → "Qoo10 Megapo Capture" → Enable
3. 첫날 실행 결과 확인 — 특히 **3·6·9·11월 메가와리는 페이지 구조가 다를 수 있음**. 랭킹 파싱이 50건 미만이면 실행이 실패(빨간 X)하고 GitHub가 이메일로 알려줌 → 파싱 수정 필요
4. 종료일이 지나면 워크플로가 **스스로 Disable** (수동 조작 불필요)

수동 실행(기간 무관): Actions 탭 → Run workflow (mode: `ranking` / `screenshot`)

## 참고

- GitHub cron은 정시에서 수 분~수십 분 지연될 수 있음 (23:45 실행이 자정을 넘기면 그날 일일 랭킹 스크린샷은 생략됨)
- private repo 무료 실행시간(월 2,000분) 내 운영을 위해 이벤트 기간 외 가동 금지
