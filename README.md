# qoo10-megapo-tracker

Qoo10 Japan 메가포/메가와리 이벤트 자동 기록 (GitHub Actions).

## 수집 스케줄 (이벤트 기간 중, JST 기준)

- **매시간 랭킹 1~100위** → `data/cumulative.csv` 누적 (저장일/저장시각/순위/상품코드/상품명/최종가/점포/브랜드/참고가·판매가·타임세일가/쿠폰할인율/포인트/자사상품여부/순위변동). 원본 HTML은 `data/html/*.html.gz`
  - **주 트리거: cron-job.org 매시 :46 JST** (workflow_dispatch 호출 — GitHub cron 불안정 보완)
  - 백업: GitHub cron :45·:15 — 직전 40분 내 수집이 있으면 수십 초 만에 skip
- **매일 23:45** — 랭킹 페이지 전체 스크린샷 → `data/screenshots/ranking_realtime_*.jpg`
- **매일 23시 실행에서 누적금액순 9세트** — 카테고리별(종합·뷰티·식품) + 연령대별(전연령·10~50대) 각 1~100위 CSV 저장(`랭킹종류`=금액순, `카테고리` 컬럼 구분) + 세트별 랭킹 영역 스크린샷(`ranking_amount_<세트>_<날짜>.jpg`)
- **매일 09:30** — 이벤트 메인 페이지 전체 스크린샷 → `data/screenshots/megapo_main_*.jpg` (주 트리거: cron-job.org 09:31 JST / 백업: GitHub cron)
- **워치리스트** — `watch_list.txt`의 자사 브랜드명(영문/가타카나) 또는 상품코드가 랭킹에 매칭되면 '자사상품여부' 컬럼 Y + 매시간 랭킹 스크린샷 추가

샵·브랜드·가격 상세는 상품 페이지를 방문해 수집 (상품별 3시간 캐시 `data/product_cache.json`).

## 매 이벤트 운영 (매달 URL 변경됨)

1. `event_config.txt`에서 기간(period)·랭킹 URL·이벤트 URL 세 줄 수정 (시작 전날까지)
2. 첫날 실행 결과 확인 — 특히 **3·6·9·11월 메가와리는 페이지 구조가 다를 수 있음**. 랭킹 파싱이 50건 미만이면 실행이 실패(빨간 X)하고 GitHub가 이메일로 알려줌 → 파싱 수정 필요

Enable/Disable 조작은 불필요 — 기간 밖 호출(외부 트리거·cron)은 기간 체크로 수십 초 만에 자동 스킵됨.

수동 실행: Actions 탭 → Run workflow (mode: `ranking` / `screenshot`; 기간 외 강제 실행은 force=`true`)

## 참고

- GitHub cron은 정시에서 수 분~수십 분 지연될 수 있음 (23:45 실행이 자정을 넘기면 그날 일일 랭킹 스크린샷은 생략됨)
- **GitHub cron은 신뢰 불가** (2026-07-08~09 관측: tick ~75% 누락, 공백 2~4시간; 워크플로 push·enable 호출 직후엔 수 시간 정지). 그래서 주 수집은 cron-job.org 외부 트리거가 담당하고 GitHub cron은 백업 — cron-job.org의 PAT(fine-grained, 이 repo Actions write)는 만료 시 갱신 필요
- 2026-07-08 public 전환 — Actions 실행시간 한도 없음. 이벤트 기간 관리는 event_config.txt가 자동 처리
