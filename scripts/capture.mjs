// Qoo10 Megapo capture (GitHub Actions)
// mode 'ranking'   : sid=22 realtime ranking -> cumulative CSV (+product enrichment) + gzipped HTML + watch screenshots
// mode 'screenshot': sid=1422 event main page -> full-page JPEG
import { chromium } from 'playwright';
import fs from 'node:fs';
import zlib from 'node:zlib';

// URLs come from event_config.txt (edited per event); fallbacks are the 2026-07 megapo pages
const cfgText = fs.existsSync('event_config.txt') ? fs.readFileSync('event_config.txt', 'utf8') : '';
const cfgVal = (key, def) => {
  const m = cfgText.match(new RegExp('^' + key + '\\s*:\\s*(\\S+)', 'm'));
  return m ? m[1] : def;
};
const RANKING_URL = cfgVal('ranking_url', 'https://www.qoo10.jp/gmkt.inc/Special/Special.aspx?sid=22');
// 스크린샷은 이벤트별 하위 폴더에 저장 (예: data/screenshots/2608 megapo/) — event_config의 event_name
const EVENT_NAME = ((cfgText.match(/^event_name\s*:\s*(.+)$/m) || [])[1] || 'event').trim();
const SHOT_DIR = `data/screenshots/${EVENT_NAME}`;
const EVENT_URL = cfgVal('event_url', 'https://www.qoo10.jp/gmkt.inc/Special/Special.aspx?sid=1422');
const GOODS_URL = (code) => `https://www.qoo10.jp/gmkt.inc/goods/goods.aspx?goodscode=${code}`;
const ENRICH_TTL_HOURS = 3;
const CACHE_PATH = 'data/product_cache.json';
const LASTRUN_PATH = 'data/last_run.json';
const CUM_PATH = 'data/cumulative.csv';
const WATCH_PATH = 'watch_list.txt';

// ── 큐텐 혼잡 게이트 대응 (2026-08-28 메가와리 개시일 실측) ────────────────────
// 개시 직후·타임세일 시각엔 사이트 전체가 wait-notice.qoo10.jp 대기 페이지로 리다이렉트돼
// 랭킹 마크업이 아예 없다(17:46 정규·17:50 백업 두 실행 연속 셀렉터 타임아웃 → 그 시간대 유실).
// 랭킹은 매시 :40~45에 갱신되므로 다음 갱신 직전(:38)까지 3분 간격으로 계속 재시도한다.
// 게이트가 아닌 실패(구조 변경 등)는 재시도하지 않고 즉시 던져 실패 메일로 드러나게 둔다.
const RANK_SELECTOR = '.list_v2_item .rank_current';
const GATE_HOST = 'wait-notice.qoo10.jp';
const GATE_TEXT = 'アクセスが集中';
const GATE_RETRY_GAP_MS = 3 * 60 * 1000;
// JST와 UTC는 분이 같으므로 러너의 분값을 그대로 쓴다. 잡 timeout(50분) 안에서 끝나도록 44분으로도 조인다.
const gateDeadline = () => {
  const min = new Date().getMinutes();
  const untilNext38Ms = (min < 38 ? 38 - min : 98 - min) * 60 * 1000;
  return Date.now() + Math.min(untilNext38Ms, 44 * 60 * 1000);
};
const isGated = async (page) => {
  if (page.url().includes(GATE_HOST)) return true;
  const html = await page.content().catch(() => '');
  return html.includes(GATE_TEXT);
};
// selector가 null이면 페이지 도달만 확인 (이벤트 페이지 스크린샷용 — 게이트 화면이 찍히는 것을 막는다)
const openWithGateRetry = async (page, url, selector, label) => {
  const deadline = gateDeadline();
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      if (selector) await page.waitForSelector(selector, { timeout: attempt === 1 ? 60000 : 25000 });
      else if (await isGated(page)) throw new Error('congestion gate');
      if (attempt > 1) console.log(`${label}: recovered on attempt ${attempt}`);
      return;
    } catch (e) {
      if (!(await isGated(page))) {
        // 게이트가 아닌 실패 — 일시적 렌더 지연일 수 있어 짧게 2회만 더 본다
        // (2026-08-28 23:02 prewarm이 이 경우로 실패. 구조 변경이면 여전히 ~2분 안에 실패로 드러난다)
        if (attempt >= 3) throw e;
        console.log(`${label}: selector miss (attempt ${attempt}) -> quick retry in 20s`);
        await page.waitForTimeout(20000);
        continue;
      }
      if (Date.now() + GATE_RETRY_GAP_MS > deadline) {
        throw new Error(`Qoo10 congestion gate persisted through ${attempt} attempts (${label})`);
      }
      console.log(`${label}: congestion gate (attempt ${attempt}) -> retry in 3 min`);
      await page.waitForTimeout(GATE_RETRY_GAP_MS);
    }
  }
};

const COLS = [
  ['captured_date', '저장일'],
  ['captured_time', '저장시각'],
  ['rank', '순위'],
  ['goodscode', '상품코드'],
  ['title', '상품명'],
  ['list_price_yen', '최종가'],
  ['shop_id', '점포ID'],
  ['shop_name', '점포명'],
  ['brand', '브랜드'],
  ['ref_price_yen', '참고가격'],
  ['sell_price_yen', '판매가격'],
  ['timesale_price_yen', '타임세일가'],
  ['timesale_hours', '타임세일시간'],
  ['megapo_coupon_pct', '쿠폰할인율'],
  ['megapoint', '포인트'],
  ['watch', '자사상품여부'],
  ['prev_rank', '이전순위'],
  ['change', '변동'],
  ['url', '상품URL'],
  ['rank_kind', '랭킹종류'],
  ['rank_category', '카테고리'],
];
const KEYS = COLS.map((c) => c[0]);
const LABELS = COLS.map((c) => c[1]);

// 누적금액순 수집 대상 (매일 23시 실행에서 1회) — loadRankingData(type, tab, group, age)
// group 코드는 카테고리별 탭, age 코드는 연령대별 탭 onclick 인자에서 확인 (2026-07-09)
// !! 타입 코드 함정: 'Q'=累積件数順(건수순), 'T'=累積金額順(금액순) — 클래스명(btn_amount=Q,
// btn_order=T)이 표시 라벨과 반대. 2026-07-10 탭 라벨 이미지로 검증 (7/9 수집분은 건수순이었음)
// 수집 스위트: 금액순(T) = CSV + 스크린샷(카테고리별 매일, 연령대별은 마지막날 1회) / 건수순(Q) = CSV만
const RANK_SUITES = [
  { key: 'amount', kind: '금액순', type: 'T' },
  { key: 'count', kind: '건수순', type: 'Q' },
];
const EVENT_END_DATE = (cfgText.match(/\d{4}-\d{2}-\d{2}\s*~\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
const AMOUNT_SETS = [
  { key: 'total', tab: 'C', group: 0, age: 0, label: '종합' },
  { key: 'beauty', tab: 'C', group: 2, age: 0, label: '뷰티' },
  { key: 'food', tab: 'C', group: 6, age: 0, label: '식품' },
  { key: 'age0', tab: 'A', group: 0, age: 0, label: '전연령' },
  { key: 'age10', tab: 'A', group: 0, age: 10, label: '10대' },
  { key: 'age20', tab: 'A', group: 0, age: 20, label: '20대' },
  { key: 'age30', tab: 'A', group: 0, age: 30, label: '30대' },
  { key: 'age40', tab: 'A', group: 0, age: 40, label: '40대' },
  { key: 'age50', tab: 'A', group: 0, age: 50, label: '50대' },
];

const mode = process.argv[2] || 'ranking';

function jstParts() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }); // "YYYY-MM-DD HH:mm:ss"
  const [date, time] = s.split(' ');
  return { date, hm: time.slice(0, 5), file: `${date}_${time.slice(0, 2)}${time.slice(3, 5)}` };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function csvField(v) {
  const s = String(v == null ? '' : v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseGoodsPage(html) {
  const pick = (re) => {
    const m = html.match(re);
    return m ? m[1].trim() : '';
  };
  const shopM = html.match(/href="https:\/\/www\.qoo10\.jp\/shop\/([^"?]+)"[^>]*class="name">([^<]+)/);
  return {
    shop_id: shopM ? shopM[1] : '',
    shop_name: shopM ? shopM[2].trim() : '',
    brand: pick(/"brand"\s*:\s*\{"@type":"Brand","name":"([^"]*)"/),
    ref_price_yen: pick(/参考価格<\/dt>\s*<dd>\s*([\d,]+)/).replace(/,/g, ''),
    sell_price_yen: pick(/id="dl_sell_price"[\s\S]{0,300}?<strong[^>]*>\s*([\d,]+)/).replace(/,/g, ''),
    timesale_price_yen: pick(/タイムセール価格<\/strong><\/dt>\s*<dd>\s*<strong[^>]*>\s*([\d,]+)/).replace(/,/g, ''),
    timesale_hours: pick(/セール実施時間\s*([0-9:~\s]+)/),
    megapo_coupon_pct: pick(/class="discount">最大(\d+)%/),
    megapoint: pick(/id="span_megapoint">([\d,]+)/).replace(/,/g, ''),
  };
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 1200 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  locale: 'ja-JP',
});

try {
  const t = jstParts();

  if (mode === 'prewarm') {
    // 상품 상세 캐시 예열 전용 (매일 23:02 트리거) — 23:46 본 수집의 보강이 자정 전에 끝나도록
    // 리얼타임+금액순 9세트의 상품코드를 훑어 캐시만 갱신. CSV/스크린샷 저장 없음.
    await openWithGateRetry(page, RANKING_URL, RANK_SELECTOR, `${mode} ranking`);
    const codes = new Set();
    const collectCodes = async () => {
      const cs = await page.$$eval('.list_v2_item a[href*="goodscode="]', (as) =>
        as.map((a) => (((a.getAttribute('href') || '').match(/goodscode=(\d+)/) || [])[1])).filter(Boolean)
      );
      for (const c of cs) codes.add(c);
      const first = await page.evaluate(() => {
        const g = window.loadJsonData && window.loadJsonData.firstItem && window.loadJsonData.firstItem.goods;
        return g && g.GD_NO ? String(g.GD_NO) : null;
      });
      if (first) codes.add(first);
    };
    await collectCodes(); // 리얼타임
    for (const suite of RANK_SUITES) {
      for (const set of AMOUNT_SETS) {
        try {
          await page.evaluate((s) => loadRankingData(s.type, s.tab, s.group, s.age), { ...set, type: suite.type });
          await page.waitForFunction(
            (s) => window.type === s.type && window.tab === s.tab && Number(window.groupCode) === s.group && Number(window.age) === s.age,
            { ...set, type: suite.type },
            { timeout: 30000 }
          );
          await page.waitForTimeout(800);
          await collectCodes();
        } catch (e) {
          console.log(`prewarm ${suite.key} ${set.key} skipped: ${e.message}`);
        }
      }
    }
    const cache = readJson(CACHE_PATH, {});
    const stale = [...codes].filter((code) => {
      const hit = cache[code];
      return !hit || !hit.enriched_at_ms || Date.now() - hit.enriched_at_ms > ENRICH_TTL_HOURS * 3600 * 1000;
    });
    console.log(`prewarm: ${codes.size} codes, enriching ${stale.length}`);
    let warmed = 0;
    for (const code of stale) {
      if (jstParts().date !== t.date) {
        console.log(`prewarm cutoff: date rolled past ${t.date}`);
        break;
      }
      try {
        await page.goto(GOODS_URL(code), { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(500);
        cache[code] = { ...parseGoodsPage(await page.content()), enriched_at_ms: Date.now() };
        warmed++;
      } catch (e) {
        console.log(`prewarm enrich failed for ${code}: ${e.message}`);
      }
    }
    ensureDir('data');
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
    console.log(`prewarm done: ${warmed}/${stale.length} enriched`);
  } else if (mode === 'screenshot') {
    await openWithGateRetry(page, EVENT_URL, null, 'event page');
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 1000) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 200));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(3000);
    ensureDir(SHOT_DIR);
    await page.screenshot({
      path: `${SHOT_DIR}/megawari_main_${t.date}.jpg`,
      fullPage: true,
      type: 'jpeg',
      quality: 80,
    });
    console.log(`screenshot saved: megawari_main_${t.date}.jpg`);
  } else if (mode === 'supple') {
    // 일회성: サプリ・ダイエット 누적 랭킹 회수. 이 카테고리는 랭킹 페이지 내 탭이 아니라
    // 별도 페이지 링크다(1차 시도에서 클릭 후 loadRankingData 소실로 판명, 2026-09-05).
    // 매시 :40~45 갱신 전이면 어제 마감 랭킹 그대로 → 금액순 종합 상위를 어제 마감 저장분과 대조.
    await openWithGateRetry(page, RANKING_URL, RANK_SELECTOR, 'supple ranking');
    const parseList = () => page.$$eval('.list_v2_item', (lis) =>
      lis.map((li) => {
        const a = li.querySelector('a[href*="goodscode="]');
        const rankEl = li.querySelector('.rank_current');
        const titleEl = li.querySelector('.list_v2_title');
        const priceEl = li.querySelector('.price_final_value');
        if (!a || !rankEl) return null;
        const m = (a.getAttribute('href') || '').match(/goodscode=(\d+)/);
        return {
          rank: parseInt(rankEl.textContent.trim(), 10),
          goodscode: m ? m[1] : '',
          title: titleEl ? (titleEl.getAttribute('title') || titleEl.textContent).trim() : '',
          list_price_yen: priceEl ? priceEl.textContent.replace(/[^\d]/g, '') : '',
        };
      }).filter(Boolean));
    const heroFirst = () => page.evaluate(() => {
      const fi = window.loadJsonData && window.loadJsonData.firstItem;
      const code = fi && fi.connectUrl ? (String(fi.connectUrl).match(/goodscode=(\d+)/) || [])[1] : null;
      if (code) return { rank: 1, goodscode: code, title: String(fi.gdNm || '').trim(), list_price_yen: String(fi.finalPriceText || '').replace(/[^\d]/g, '') };
      const a = document.querySelector('.wrap_rank1st a[href*="goodscode="]');
      const m = a && (a.getAttribute('href') || '').match(/goodscode=(\d+)/);
      if (!m) return null;
      const t = document.querySelector('.wrap_rank1st .info .title');
      return { rank: 1, goodscode: m[1], title: t ? (t.getAttribute('title') || t.textContent).trim() : '', list_price_yen: '' };
    });

    // 1) 검증: 금액순 종합 top6 vs 어제 마감(23:4x) 저장분
    await page.evaluate(() => loadRankingData('T', 'C', 0, 0));
    await page.waitForFunction(() => window.type === 'T' && window.tab === 'C', null, { timeout: 30000 });
    await page.waitForTimeout(1000);
    const totalNow = (await parseList()).slice(0, 6);
    const yesterday = new Date(Date.now() + 9 * 3600 * 1000 - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const savedRows = fs.readFileSync(CUM_PATH, 'utf8').split(/\r?\n/)
      .filter((L) => L.startsWith(`${yesterday},23:4`) && /,금액순,종합\s*$/.test(L));
    const savedTime = savedRows.length ? savedRows[0].split(',')[1] : '';
    const savedSet = new Set(savedRows.map((L) => { const f = L.split(','); return `${f[2]}|${f[3]}`; }));
    const hits = totalNow.filter((it) => savedSet.has(`${it.rank}|${it.goodscode}`)).length;
    const matched = savedSet.size > 0 && hits >= 4;
    console.log(`verify vs ${yesterday} ${savedTime} total (saved ${savedSet.size} rows): ${hits}/${totalNow.length} matched -> ${matched ? 'stamping as yesterday close' : 'stamping as NOW'}`);
    const stampDate = matched ? yesterday : t.date;
    const stampTime = matched ? savedTime : t.hm;

    // 2) 랭킹 카테고리 그리드의 サプリ・ダイエット 아이콘을 정확 매칭해 클릭 → 목적지 파악
    //    (글로벌 네비의 Group.aspx 카테고리 링크는 제외 — 1차 오탐)
    const candidates = await page.evaluate(() => {
      const out = [];
      for (const e of document.querySelectorAll('a,button,li,span,div')) {
        const t = (e.textContent || '').trim().replace(/\s+/g, '');
        if (t !== 'サプリ・ダイエット') continue;
        const a = e.closest('a');
        out.push({ tag: e.tagName, cls: String(e.className).slice(0, 40), href: a ? (a.getAttribute('href') || '') : '', oc: (e.getAttribute('onclick') || (a ? a.getAttribute('onclick') : '') || '').slice(0, 80) });
      }
      return out;
    });
    console.log('supple candidates: ' + JSON.stringify(candidates));
    const beforeUrl = page.url();
    const clicked = await page.evaluate(() => {
      for (const e of document.querySelectorAll('a,button,li,span,div')) {
        const t = (e.textContent || '').trim().replace(/\s+/g, '');
        if (t !== 'サプリ・ダイエット') continue;
        const a = e.closest('a');
        if (a && (a.getAttribute('href') || '').includes('Group.aspx')) continue;
        (a || e).click();
        return true;
      }
      return false;
    });
    if (!clicked) throw new Error('supple grid icon not found');
    await page.waitForLoadState('domcontentloaded').catch(() => null);
    await page.waitForTimeout(4000);
    console.log(`landed: ${page.url()} (navigated: ${page.url() !== beforeUrl})`);
    await page.waitForSelector(RANK_SELECTOR, { timeout: 45000 });
    const recon = await page.evaluate(() => ({
      url: location.href, title: document.title,
      hasLoad: typeof window.loadRankingData,
      type: window.type, tab: window.tab, group: Number(window.groupCode), age: Number(window.age),
      items: document.querySelectorAll('.list_v2_item').length,
    }));
    console.log('recon: ' + JSON.stringify(recon));

    // 3) 금액순(T)·건수순(Q) 수집 — 이동한 페이지의 기본 tab/group/age를 그대로 쓰고 type만 전환
    const cache = readJson(CACHE_PATH, {});
    const empty = { shop_id: '', shop_name: '', brand: '', ref_price_yen: '', sell_price_yen: '', timesale_price_yen: '', timesale_hours: '', megapo_coupon_pct: '', megapoint: '' };
    const outRows = [];
    for (const suite of RANK_SUITES) {
      if (recon.hasLoad === 'function') {
        await page.evaluate((s) => loadRankingData(s.ty, window.tab, Number(window.groupCode) || 0, Number(window.age) || 0), { ty: suite.type });
        await page.waitForFunction((ty) => window.type === ty, suite.type, { timeout: 30000 });
        await page.waitForTimeout(1000);
      } else if (suite.key !== 'amount') {
        console.log('no loadRankingData on supple page -> single snapshot only');
        break;
      }
      const list = await parseList();
      const first = await heroFirst();
      const items = first && !list.some((x) => x.rank === 1) ? [first, ...list] : list;
      if (items.length < 50) throw new Error(`supple ${suite.kind}: only ${items.length} items`);
      console.log(`supple ${suite.kind}: ${items.length} items, top3 ${items.slice(0, 3).map((x) => x.goodscode).join('/')}`);
      if (suite.key === 'amount') {
        ensureDir(SHOT_DIR);
        await page.screenshot({ path: `${SHOT_DIR}/ranking_amount_supple_${stampDate}.jpg`, fullPage: true, type: 'jpeg', quality: 75 });
      }
      for (const it of items) {
        const info = cache[it.goodscode] || empty;
        outRows.push({
          captured_date: stampDate, captured_time: stampTime, rank: it.rank, goodscode: it.goodscode,
          title: it.title, list_price_yen: it.list_price_yen,
          shop_id: info.shop_id || '', shop_name: info.shop_name || '', brand: info.brand || '',
          ref_price_yen: info.ref_price_yen || '', sell_price_yen: info.sell_price_yen || '',
          timesale_price_yen: info.timesale_price_yen || '', timesale_hours: info.timesale_hours || '',
          megapo_coupon_pct: info.megapo_coupon_pct || '', megapoint: info.megapoint || '',
          watch: '', prev_rank: '', change: '-', url: GOODS_URL(it.goodscode),
          rank_kind: suite.kind, rank_category: '서플다이어트',
        });
      }
    }
    fs.appendFileSync(CUM_PATH, outRows.map((r) => KEYS.map((k) => csvField(r[k])).join(',')).join('\r\n') + '\r\n');
    console.log(`supple saved: ${outRows.length} rows stamped ${stampDate} ${stampTime}`);
  } else if (mode === 'debug') {

    // 일회성 진단: 메가와리 랭킹 페이지의 실제 마크업 확인 (2026-08-28 sid=22 종료 판명 후)
    for (const [label, url] of [['ranking', RANKING_URL], ['event', EVENT_URL]]) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(8000);
      const info = await page.evaluate(() => {
        const n = (sel) => { try { return document.querySelectorAll(sel).length; } catch (e) { return -1; } };
        const cls = [...new Set([...document.querySelectorAll('ul,ol,div,section')]
          .map((e) => (typeof e.className === 'string' ? e.className : ''))
          .filter((c) => /rank|best|list_item|goods/i.test(c)))].slice(0, 30);
        return {
          url: location.href,
          title: document.title,
          counts: {
            'ul.megasale_rank_list': n('ul.megasale_rank_list'),
            '.rank_num': n('.rank_num'),
            '[class*=rank]': n('[class*=rank]'),
            'a[href*=goodscode]': n('a[href*=goodscode]'),
          },
          loadRankingData: typeof window.loadRankingData,
          loadJsonData: typeof window.loadJsonData,
          classes: cls,
        };
      });
      console.log(`[debug:${label}] ` + JSON.stringify(info));
      if (label === 'ranking') {
        const sample = await page.evaluate(() => {
          const cont = document.querySelector('.list_v2_rank');
          const hero = document.querySelector('.rank_1st');
          return {
            listCount: document.querySelectorAll('.list_v2_rank').length,
            itemClean: (() => {
              const it = document.querySelector('.list_v2_item');
              if (!it) return null;
              const c = it.cloneNode(true);
              c.querySelectorAll('svg,button,defs,filter').forEach((e) => e.remove());
              return c.outerHTML.replace(/\s+/g, ' ').slice(0, 2400);
            })(),
            itemClasses: [...new Set([...document.querySelectorAll('.list_v2_item:first-of-type *')]
              .map((e) => (typeof e.className === 'string' ? e.className.trim() : '')).filter(Boolean))].slice(0, 40),
          };
        });
        console.log('[debug:sample] ' + JSON.stringify(sample));
        // 누적 랭킹 세트 전환이 새 마크업에서도 동작하는지 사전 검증 (23:45 본 수집 전에 확인)
        const PROBES = [];
        for (const su of RANK_SUITES) for (const st of AMOUNT_SETS)
          PROBES.push({ type: su.type, tab: st.tab, group: st.group, age: st.age, kind: su.kind, cat: st.label });
        for (const probe of PROBES) {
          const r = { probe };
          try {
            await page.evaluate((s) => loadRankingData(s.type, s.tab, s.group, s.age), probe);
            await page.waitForFunction(
              (s) => window.type === s.type && window.tab === s.tab && Number(window.groupCode) === s.group && Number(window.age) === s.age,
              probe,
              { timeout: 30000 }
            );
            await page.waitForTimeout(1000);
            r.globals = await page.evaluate(() => ({ type: window.type, tab: window.tab, groupCode: window.groupCode, age: window.age }));
            r.items = await page.$$eval('.list_v2_item', (l) => l.length);
            r.rank2 = await page.evaluate(() => {
              const it = document.querySelector('.list_v2_item');
              const a = it && it.querySelector('a[href*="goodscode="]');
              const rk = it && it.querySelector('.rank_current');
              const m = a && (a.getAttribute('href') || '').match(/goodscode=(\d+)/);
              return m ? { rank: rk && rk.textContent.trim(), goodscode: m[1] } : null;
            });
            // 본 수집(dailyShot)의 1위 추출과 동일한 로직을 그대로 돌려 결과를 확인한다
            r.rank1 = await page.evaluate(() => {
              const fi = window.loadJsonData && window.loadJsonData.firstItem;
              const g = fi && fi.goods;
              if (g && g.GD_NO) {
                const promo = (g.PROMOTION_INFO && g.PROMOTION_INFO[0]) || null;
                const price = promo && promo.PROMOTION_PRICE ? promo.PROMOTION_PRICE : g.FINAL_PRICE;
                return { via: 'nested', rank: 1, goodscode: String(g.GD_NO), title: (g.GD_NM || '').trim().slice(0, 16), list_price_yen: price ? String(price) : '' };
              }
              const code = fi && fi.connectUrl ? (String(fi.connectUrl).match(/goodscode=(\d+)/) || [])[1] : null;
              if (code) {
                return { via: 'flat', rank: 1, goodscode: code, title: String(fi.gdNm || '').trim().slice(0, 16), list_price_yen: String(fi.finalPriceText || '').replace(/[^\d]/g, '') };
              }
              const a = document.querySelector('.wrap_rank1st a[href*="goodscode="]');
              const m = a && (a.getAttribute('href') || '').match(/goodscode=(\d+)/);
              if (!m) return null;
              const t = document.querySelector('.wrap_rank1st .info .title');
              return { via: 'dom', rank: 1, goodscode: m[1], title: t ? (t.getAttribute('title') || t.textContent).trim().slice(0, 16) : '', list_price_yen: '' };
            });
          } catch (e) {
            r.error = e.message.slice(0, 120);
          }
          console.log('[debug:suite] ' + JSON.stringify(r));
        }
      }
    }
  } else {
    await openWithGateRetry(page, RANKING_URL, RANK_SELECTOR, `${mode} ranking`);

    const items = await page.$$eval('.list_v2_item', (lis) =>
      lis
        .map((li) => {
          const a = li.querySelector('a[href*="goodscode="]');
          const rankEl = li.querySelector('.rank_current');
          const titleEl = li.querySelector('.list_v2_title');
          const priceEl = li.querySelector('.price_final_value');
          if (!a || !rankEl) return null;
          const m = (a.getAttribute('href') || '').match(/goodscode=(\d+)/);
          return {
            rank: parseInt(rankEl.textContent.trim(), 10),
            goodscode: m ? m[1] : '',
            title: titleEl ? (titleEl.getAttribute('title') || titleEl.textContent).trim() : '',
            list_price_yen: priceEl ? priceEl.textContent.replace(/[^\d]/g, '') : '',
          };
        })
        .filter(Boolean)
    );
    if (items.length < 50) throw new Error(`only ${items.length} items parsed`);

    // gzipped original HTML
    ensureDir('data/html');
    const html = await page.content();
    fs.writeFileSync(`data/html/ranking_realtime_${t.file}.html.gz`, zlib.gzipSync(Buffer.from(html, 'utf8')));

    // ===== 23:45 일일 수집 선행부: 순위 파싱·스크린샷을 상세 보강보다 먼저 (자정 대비) =====
    // 조건은 "23:45 이후 시작"으로 엄격화 — 23시대 이른 실행(백업 cron 등)이 22:4x 갱신분으로
    // 일일 수집을 대신하는 것을 방지. 트리거는 매일 23:46 외부 스케줄러.
    const dailyShot = parseInt(t.hm.slice(0, 2), 10) === 23 && t.hm >= '23:45';
    const collected = [];
    const suiteFailures = [];
    if (dailyShot) {
      ensureDir(SHOT_DIR);
      const isLastDay = EVENT_END_DATE && t.date === EVENT_END_DATE;
      // 일일 리얼타임 전체 스크린샷 (페이지는 이미 랭킹 페이지)
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 1000) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 150));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${SHOT_DIR}/ranking_realtime_${t.file}.jpg`, fullPage: true, type: 'jpeg', quality: 75 });
      console.log('daily realtime screenshot saved');

      // 누적 랭킹(금액순 T + 건수순 Q) 각 9세트 파싱 — 마지막 날 자정 직후 페이지가 닫혀도
      // 그때까지 수집한 세트는 저장되도록 세트별 실패 허용
      suiteLoop: for (const suite of RANK_SUITES) {
      for (const set of AMOUNT_SETS) {
        try {
        await page.evaluate((s) => loadRankingData(s.type, s.tab, s.group, s.age), { ...set, type: suite.type });
        await page.waitForFunction(
          (s) => window.type === s.type && window.tab === s.tab && Number(window.groupCode) === s.group && Number(window.age) === s.age,
          { ...set, type: suite.type },
          { timeout: 30000 }
        );
        await page.waitForTimeout(1000);

        const listItems = await page.$$eval('.list_v2_item', (lis) =>
          lis
            .map((li) => {
              const a = li.querySelector('a[href*="goodscode="]');
              const rankEl = li.querySelector('.rank_current');
              const titleEl = li.querySelector('.list_v2_title');
              const priceEl = li.querySelector('.price_final_value');
              if (!a || !rankEl) return null;
              const m = (a.getAttribute('href') || '').match(/goodscode=(\d+)/);
              return {
                rank: parseInt(rankEl.textContent.trim(), 10),
                goodscode: m ? m[1] : '',
                title: titleEl ? (titleEl.getAttribute('title') || titleEl.textContent).trim() : '',
                list_price_yen: priceEl ? priceEl.textContent.replace(/[^\d]/g, '') : '',
              };
            })
            .filter(Boolean)
        );
        // 누적 탭의 1위는 리스트(.list_v2_item) 밖 왕관 히어로 카드(.wrap_rank1st) — 세트 전환 시 함께 갱신된다.
        // firstItem 구조는 이벤트에 따라 다르다: 메가포=중첩(goods.GD_NO), 메가와리=평면(gdNm/connectUrl/finalPriceText,
        // 2026-08-28 확인). 둘 다 실패하면 히어로 DOM에서 직접 읽는다.
        const first = await page.evaluate(() => {
          const fi = window.loadJsonData && window.loadJsonData.firstItem;
          const g = fi && fi.goods;
          if (g && g.GD_NO) {
            const promo = (g.PROMOTION_INFO && g.PROMOTION_INFO[0]) || null;
            const price = promo && promo.PROMOTION_PRICE ? promo.PROMOTION_PRICE : g.FINAL_PRICE;
            return { rank: 1, goodscode: String(g.GD_NO), title: (g.GD_NM || '').trim(), list_price_yen: price ? String(price) : '' };
          }
          const code = fi && fi.connectUrl ? (String(fi.connectUrl).match(/goodscode=(\d+)/) || [])[1] : null;
          if (code) {
            return {
              rank: 1,
              goodscode: code,
              title: String(fi.gdNm || '').trim(),
              list_price_yen: String(fi.finalPriceText || '').replace(/[^\d]/g, ''),
            };
          }
          const a = document.querySelector('.wrap_rank1st a[href*="goodscode="]');
          const m = a && (a.getAttribute('href') || '').match(/goodscode=(\d+)/);
          if (!m) return null;
          const t = document.querySelector('.wrap_rank1st .info .title');
          return { rank: 1, goodscode: m[1], title: t ? (t.getAttribute('title') || t.textContent).trim() : '', list_price_yen: '' };
        });
        const setItems = first && !listItems.some((it) => it.rank === 1) ? [first, ...listItems] : listItems;
        if (setItems.length < 50) throw new Error(`${suite.key} ${set.key}: only ${setItems.length} items parsed`);

        fs.writeFileSync(`data/html/ranking_${suite.key}_${set.key}_${t.file}.html.gz`, zlib.gzipSync(Buffer.from(await page.content(), 'utf8')));
        // 스크린샷: 금액순 카테고리별(종합·뷰티·식품)은 매일, 금액순 연령대별은 마지막날 1회, 건수순은 없음
        if (suite.key === 'amount' && (set.tab === 'C' || isLastDay)) {
          await page.evaluate(async () => {
            for (let y = 0; y < document.body.scrollHeight; y += 1000) {
              window.scrollTo(0, y);
              await new Promise((r) => setTimeout(r, 120));
            }
            window.scrollTo(0, 0);
          });
          await page.waitForTimeout(1500); // 지연로딩 이미지 마무리 대기
          try {
            const area = await page.$('#special_wrap_202602');
            if (!area) throw new Error('rank area not found');
            await area.screenshot({ path: `${SHOT_DIR}/ranking_amount_${set.key}_${t.date}.jpg`, type: 'jpeg', quality: 75 });
          } catch (e) {
            console.log(`amount ${set.key}: element shot failed (${e.message}) -> fullPage`);
            await page.screenshot({ path: `${SHOT_DIR}/ranking_amount_${set.key}_${t.date}.jpg`, fullPage: true, type: 'jpeg', quality: 75 });
          }
        }
        console.log(`${suite.key} ${set.key}: ${setItems.length} items, top3 ${setItems.slice(0, 3).map((x) => x.goodscode).join('/')}`);
        collected.push({ suite, set, items: setItems });
        } catch (e) {
          suiteFailures.push(`${suite.key}/${set.key}: ${e.message}`);
          // 자정을 넘겼으면 페이지가 닫힌 것 — 이후 세트도 실패하므로 전체 중단.
          // 자정 전이면 일시적 타임아웃일 수 있으니 다음 세트로 계속
          // (2026-08-29 amount/age50 30초 타임아웃 1건이 이후 10세트를 연쇄 유실시킨 사고 재발 방지).
          const rolled = jstParts().date !== t.date;
          console.log(`${suite.key} ${set.key} FAILED: ${e.message} -> ${rolled ? 'past midnight, stopping remaining sets' : 'continuing with next set'}`);
          if (rolled) break suiteLoop;
        }
      }
      }
      if (suiteFailures.length > 0 && collected.length === 0) throw new Error(`rank suites failed entirely: ${suiteFailures.join(' | ')}`);
      if (suiteFailures.length > 0) console.log(`WARNING: partial failure (${suiteFailures.join(' | ')}) — saving ${collected.length} sets`);
    }
    // ===== 일일 수집 선행부 끝 =====

    // watch list: [자사]/[계열] 섹션, 각 줄 "브랜드키: 토큰,토큰" (브랜드·점포명 부분일치, 대소문자 무시).
    // 상품명은 매칭에 안 씀 — ヘラ(주걱) 등 일본어 일반명사와의 오탐 방지. 숫자 단독 줄 = 상품코드.
    const WATCH = []; // { key, group('자사'|'계열'), tokens[], codes:Set }
    if (fs.existsSync(WATCH_PATH)) {
      let group = '자사';
      for (const raw of fs.readFileSync(WATCH_PATH, 'utf8').split(/\r?\n/)) {
        const s = raw.trim();
        if (!s || s.startsWith('#')) continue;
        const sec = s.match(/^\[(.+)\]$/);
        if (sec) {
          group = sec[1].trim() === '계열' ? '계열' : '자사';
          continue;
        }
        if (/^\d+$/.test(s)) {
          WATCH.push({ key: s, group, tokens: [], codes: new Set([s]) });
          continue;
        }
        const m = s.match(/^([^:]+):(.+)$/);
        if (m) WATCH.push({ key: m[1].trim(), group, tokens: m[2].split(',').map((x) => x.trim().toLowerCase()).filter(Boolean), codes: new Set() });
        else WATCH.push({ key: s.toLowerCase(), group, tokens: [s.toLowerCase()], codes: new Set() });
      }
    }
    // ASCII 토큰은 단어 경계 일치 — 브랜드명 내부 부분 문자열 오탐 방지(예: Quadthera에 hera, 2026-08-10). 일본어 토큰은 부분일치 유지.
    const tokenHit = (hay, n) => /^[\x20-\x7e]+$/.test(n)
      ? new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(hay)
      : hay.includes(n);
    const watchMatch = (goodscode, info) => {
      const hay = `${info.brand} ${info.shop_name}`.toLowerCase();
      for (const w of WATCH) {
        if (w.codes.has(goodscode) || w.tokens.some((n) => tokenHit(hay, n))) return w;
      }
      return null;
    };

    // product enrichment with TTL cache
    ensureDir('data');
    const cache = readJson(CACHE_PATH, {});
    const nowMs = Date.now();
    const stale = items.filter((it) => {
      const hit = cache[it.goodscode];
      if (!hit || !hit.enriched_at_ms) return true;
      return nowMs - hit.enriched_at_ms > ENRICH_TTL_HOURS * 3600 * 1000;
    });
    console.log(`enriching ${stale.length}/${items.length} product pages`);
    let fetched = 0;
    let failed = 0;
    for (const it of stale) {
      // 자정을 넘기면 이벤트 종료/익일 세팅 값이 긁힘 → 오염 방지 위해 중단 (빈칸이 잘못된 값보다 낫다)
      if (jstParts().date !== t.date) {
        console.log(`enrich cutoff: date rolled past ${t.date} — stopping remaining enrichment`);
        break;
      }
      try {
        await page.goto(GOODS_URL(it.goodscode), { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(500);
        const info = parseGoodsPage(await page.content());
        cache[it.goodscode] = { ...info, enriched_at_ms: Date.now() };
        fetched++;
      } catch (e) {
        failed++;
        console.log(`enrich failed for ${it.goodscode}: ${e.message}`);
      }
    }
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));

    // change detection vs previous run
    const lastRun = readJson(LASTRUN_PATH, null);
    const prevRanks = lastRun ? lastRun.ranks : null;
    let newCnt = 0;
    let upCnt = 0;
    let downCnt = 0;
    const watchHits = [];
    const brandBest = {}; // 이번 실행에서 워치 브랜드별 최고 순위
    const brandBestName = {}; // 그 최고 순위 상품명 (스크린샷 파일명용)

    const empty = parseGoodsPage('');
    const rows = items.map((it) => {
      const info = cache[it.goodscode] || empty;
      let prev = '';
      let chg = '-';
      if (prevRanks) {
        if (it.goodscode in prevRanks) {
          prev = prevRanks[it.goodscode];
          const delta = prev - it.rank;
          if (delta > 0) {
            chg = `UP ${delta}`;
            upCnt++;
          } else if (delta < 0) {
            chg = `DOWN ${-delta}`;
            downCnt++;
          } else chg = 'SAME';
        } else {
          chg = 'NEW';
          newCnt++;
        }
      }
      const w = watchMatch(it.goodscode, info);
      const watch = w ? w.group : '';
      if (w) {
        watchHits.push(`${w.key}#${it.rank}`);
        if (!brandBest[w.key] || it.rank < brandBest[w.key]) {
          brandBest[w.key] = it.rank;
          brandBestName[w.key] = it.title;
        }
      }
      return {
        captured_date: t.date,
        captured_time: t.hm,
        rank: it.rank,
        goodscode: it.goodscode,
        title: it.title,
        list_price_yen: it.list_price_yen,
        shop_id: info.shop_id,
        shop_name: info.shop_name,
        brand: info.brand,
        ref_price_yen: info.ref_price_yen,
        sell_price_yen: info.sell_price_yen,
        timesale_price_yen: info.timesale_price_yen,
        timesale_hours: info.timesale_hours,
        megapo_coupon_pct: info.megapo_coupon_pct,
        megapoint: info.megapoint,
        watch,
        prev_rank: prev,
        change: chg,
        url: GOODS_URL(it.goodscode),
        rank_kind: '리얼타임',
        rank_category: '',
      };
    });

    // append to single cumulative CSV
    const body = rows.map((r) => KEYS.map((k) => csvField(r[k])).join(',')).join('\r\n') + '\r\n';
    if (!fs.existsSync(CUM_PATH)) {
      fs.writeFileSync(CUM_PATH, '﻿' + LABELS.join(',') + '\r\n' + body); // BOM for Excel
    } else {
      fs.appendFileSync(CUM_PATH, body);
    }

    const ranks = {};
    for (const it of items) ranks[it.goodscode] = it.rank;
    // 워치 브랜드별 "오늘 최고 순위" 추적 — 갱신된 브랜드만 스크린샷 (하루 최고 시점 1장 정책)
    const prevBest = lastRun && lastRun.watchBest && lastRun.watchBest.date === t.date ? lastRun.watchBest.best : {};
    const improved = [];
    const mergedBest = { ...prevBest };
    for (const k of Object.keys(brandBest)) {
      if (!mergedBest[k] || brandBest[k] < mergedBest[k]) {
        mergedBest[k] = brandBest[k];
        improved.push(k);
      }
    }
    const watchBest = { date: t.date, best: mergedBest };
    // amountRanks(누적 세트별 전일 순위)는 23:45 실행이 아닌 시간에도 보존해야 함
    const carryAmount = lastRun && lastRun.amountRanks ? { amountRanks: lastRun.amountRanks } : {};
    fs.writeFileSync(LASTRUN_PATH, JSON.stringify({ captured: `${t.date} ${t.hm}`, ranks, watchBest, ...carryAmount }));

    // 워치 브랜드 "오늘 최고 순위 갱신" 시점 스크린샷 — 브랜드당 같은 파일 덮어쓰기 → 하루 끝에 최고 시점 1장
    if (improved.length > 0) {
      ensureDir(SHOT_DIR);
      await page.goto(RANKING_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForSelector('.list_v2_item', { timeout: 60000 });
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 1000) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 150));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(1500);
      const tmpShot = `${SHOT_DIR}/watch_tmp.jpg`;
      await page.screenshot({ path: tmpShot, fullPage: true, type: 'jpeg', quality: 75 });
      // 파일명: watch_브랜드_날짜_HH시_순위위_요약제품명.jpg — 같은 날짜의 이전 파일은 제거하고 최고 시점 1장만 유지
      const shotName = (nm) => (nm || '').replace(/【[^】]*】|\[[^\]]*\]/g, '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 10);
      for (const k of improved) {
        for (const f of fs.readdirSync(SHOT_DIR)) {
          if (f.startsWith(`watch_${k}_${t.date}`)) fs.unlinkSync(`${SHOT_DIR}/${f}`);
        }
        const nm = shotName(brandBestName[k]);
        fs.copyFileSync(tmpShot, `${SHOT_DIR}/watch_${k}_${t.date}_${t.hm.slice(0, 2)}시_${mergedBest[k]}위${nm ? '_' + nm : ''}.jpg`);
      }
      fs.unlinkSync(tmpShot);
      console.log(`watch best-rank screenshot updated: ${improved.map((k) => `${k}=${mergedBest[k]}`).join(', ')}`);
    }

    // 누적 랭킹 상세 보강·CSV 저장 (세트 파싱·스크린샷은 위 선행부에서 자정 전에 완료)
    if (dailyShot && collected.length > 0) {

      // 상품 상세 보강 (리얼타임과 3시간 캐시 공유 — 중복 상품은 재방문 없음)
      const uniq = new Map();
      for (const c of collected) for (const it of c.items) uniq.set(it.goodscode, it);
      const staleAmount = [...uniq.values()].filter((it) => {
        const hit = cache[it.goodscode];
        return !hit || !hit.enriched_at_ms || Date.now() - hit.enriched_at_ms > ENRICH_TTL_HOURS * 3600 * 1000;
      });
      console.log(`amount enrich: ${staleAmount.length}/${uniq.size} product pages`);
      for (const it of staleAmount) {
        // 자정 컷오프: 저장일과 다른 날짜의 부가필드 값은 저장하지 않음 (오염 방지)
        if (jstParts().date !== t.date) {
          console.log(`amount enrich cutoff: date rolled past ${t.date} — stopping remaining enrichment`);
          break;
        }
        try {
          await page.goto(GOODS_URL(it.goodscode), { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(500);
          cache[it.goodscode] = { ...parseGoodsPage(await page.content()), enriched_at_ms: Date.now() };
        } catch (e) {
          console.log(`amount enrich failed for ${it.goodscode}: ${e.message}`);
        }
      }
      fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));

      const prevAmount = (lastRun && lastRun.amountRanks) || {};
      const amountRanks = {};
      const amountRows = [];
      for (const c of collected) {
        const dsKey = `${c.suite.key}_${c.set.key}`;
        const prevSet = prevAmount[dsKey] || null;
        amountRanks[dsKey] = {};
        for (const it of c.items) {
          amountRanks[dsKey][it.goodscode] = it.rank;
          const info = cache[it.goodscode] || empty;
          let prev = '';
          let chg = '-';
          if (prevSet) {
            if (it.goodscode in prevSet) {
              prev = prevSet[it.goodscode];
              const d = prev - it.rank;
              chg = d > 0 ? `UP ${d}` : d < 0 ? `DOWN ${-d}` : 'SAME';
            } else chg = 'NEW';
          }
          const w = watchMatch(it.goodscode, info);
          const watch = w ? w.group : '';
          amountRows.push({
            captured_date: t.date,
            captured_time: t.hm,
            rank: it.rank,
            goodscode: it.goodscode,
            title: it.title,
            list_price_yen: it.list_price_yen,
            shop_id: info.shop_id,
            shop_name: info.shop_name,
            brand: info.brand,
            ref_price_yen: info.ref_price_yen,
            sell_price_yen: info.sell_price_yen,
            timesale_price_yen: info.timesale_price_yen,
            timesale_hours: info.timesale_hours,
            megapo_coupon_pct: info.megapo_coupon_pct,
            megapoint: info.megapoint,
            watch,
            prev_rank: prev,
            change: chg,
            url: GOODS_URL(it.goodscode),
            rank_kind: c.suite.kind,
            rank_category: c.set.label,
          });
        }
      }
      fs.appendFileSync(CUM_PATH, amountRows.map((r) => KEYS.map((k) => csvField(r[k])).join(',')).join('\r\n') + '\r\n');
      fs.writeFileSync(LASTRUN_PATH, JSON.stringify({ captured: `${t.date} ${t.hm}`, ranks, amountRanks }));
      console.log(`rank suites saved: ${amountRows.length} rows across ${collected.length} datasets`);
    }

    console.log(
      `ranking saved: ${rows.length} items at ${t.date} ${t.hm} JST (new ${newCnt} / up ${upCnt} / down ${downCnt}, enriched ${fetched}, failed ${failed}, watch ${watchHits.length})`
    );
  }
} finally {
  await browser.close();
}
