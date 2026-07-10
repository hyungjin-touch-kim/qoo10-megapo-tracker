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
const EVENT_URL = cfgVal('event_url', 'https://www.qoo10.jp/gmkt.inc/Special/Special.aspx?sid=1422');
const GOODS_URL = (code) => `https://www.qoo10.jp/gmkt.inc/goods/goods.aspx?goodscode=${code}`;
const ENRICH_TTL_HOURS = 3;
const CACHE_PATH = 'data/product_cache.json';
const LASTRUN_PATH = 'data/last_run.json';
const CUM_PATH = 'data/cumulative.csv';
const WATCH_PATH = 'watch_list.txt';

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
    await page.goto(RANKING_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('ul.megasale_rank_list li a span.rank_num', { timeout: 60000 });
    const codes = new Set();
    const collectCodes = async () => {
      const cs = await page.$$eval('ul.megasale_rank_list li a', (as) =>
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
    await page.goto(EVENT_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 1000) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 200));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(3000);
    ensureDir('data/screenshots');
    await page.screenshot({
      path: `data/screenshots/megapo_main_${t.date}.jpg`,
      fullPage: true,
      type: 'jpeg',
      quality: 80,
    });
    console.log(`screenshot saved: megapo_main_${t.date}.jpg`);
  } else {
    await page.goto(RANKING_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('ul.megasale_rank_list li a span.rank_num', { timeout: 60000 });

    const items = await page.$$eval('ul.megasale_rank_list > li', (lis) =>
      lis
        .map((li) => {
          const a = li.querySelector('a');
          const rankEl = li.querySelector('.rank_num');
          const titleEl = li.querySelector('.title');
          const priceEl = li.querySelector('.price');
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
      ensureDir('data/screenshots');
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
      await page.screenshot({ path: `data/screenshots/ranking_realtime_${t.file}.jpg`, fullPage: true, type: 'jpeg', quality: 75 });
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

        const listItems = await page.$$eval('ul.megasale_rank_list > li', (lis) =>
          lis
            .map((li) => {
              const a = li.querySelector('a');
              const rankEl = li.querySelector('.rank_num');
              const titleEl = li.querySelector('.title');
              const priceEl = li.querySelector('.price');
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
        // 1위는 리스트 밖 히어로 블록(wrap_rank1st) — 데이터는 전역 loadJsonData.firstItem에서 취득
        const first = await page.evaluate(() => {
          const g = window.loadJsonData && window.loadJsonData.firstItem && window.loadJsonData.firstItem.goods;
          if (!g || !g.GD_NO) return null;
          const promo = (g.PROMOTION_INFO && g.PROMOTION_INFO[0]) || null;
          const price = promo && promo.PROMOTION_PRICE ? promo.PROMOTION_PRICE : g.FINAL_PRICE;
          return { rank: 1, goodscode: String(g.GD_NO), title: (g.GD_NM || '').trim(), list_price_yen: price ? String(price) : '' };
        });
        const setItems = first ? [first, ...listItems] : listItems;
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
            await area.screenshot({ path: `data/screenshots/ranking_amount_${set.key}_${t.date}.jpg`, type: 'jpeg', quality: 75 });
          } catch (e) {
            console.log(`amount ${set.key}: element shot failed (${e.message}) -> fullPage`);
            await page.screenshot({ path: `data/screenshots/ranking_amount_${set.key}_${t.date}.jpg`, fullPage: true, type: 'jpeg', quality: 75 });
          }
        }
        console.log(`${suite.key} ${set.key}: ${setItems.length} items, top3 ${setItems.slice(0, 3).map((x) => x.goodscode).join('/')}`);
        collected.push({ suite, set, items: setItems });
        } catch (e) {
          suiteFailures.push(`${suite.key}/${set.key}: ${e.message}`);
          console.log(`${suite.key} ${set.key} FAILED: ${e.message} -> stopping remaining sets`);
          break suiteLoop; // 페이지 종료(자정) 가능성 — 이후 세트도 실패할 것이므로 전체 중단
        }
      }
      }
      if (suiteFailures.length > 0 && collected.length === 0) throw new Error(`rank suites failed entirely: ${suiteFailures.join(' | ')}`);
      if (suiteFailures.length > 0) console.log(`WARNING: partial failure (${suiteFailures.join(' | ')}) — saving ${collected.length} sets`);
    }
    // ===== 일일 수집 선행부 끝 =====

    // watch list: numeric lines = goodscode, text lines = brand/shop name substring (case-insensitive)
    const watchCodes = new Set();
    const watchNames = [];
    if (fs.existsSync(WATCH_PATH)) {
      for (const raw of fs.readFileSync(WATCH_PATH, 'utf8').split(/\r?\n/)) {
        const s = raw.trim();
        if (!s || s.startsWith('#')) continue;
        if (/^\d+$/.test(s)) watchCodes.add(s);
        else watchNames.push(s.toLowerCase());
      }
    }

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
      const hay = `${info.brand} ${info.shop_name}`.toLowerCase();
      const watch = watchCodes.has(it.goodscode) || watchNames.some((n) => hay.includes(n)) ? 'Y' : '';
      if (watch) watchHits.push(it.goodscode);
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
    // amountRanks(금액순 세트별 전일 순위)는 23시 실행이 아닌 시간에도 보존해야 함
    const carryAmount = lastRun && lastRun.amountRanks ? { amountRanks: lastRun.amountRanks } : {};
    fs.writeFileSync(LASTRUN_PATH, JSON.stringify({ captured: `${t.date} ${t.hm}`, ranks, ...carryAmount }));

    // watch 매칭 시간별 스크린샷 (23:45 일일 스크린샷은 선행부에서 이미 저장)
    if (watchHits.length > 0 && !dailyShot) {
      ensureDir('data/screenshots');
      await page.goto(RANKING_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForSelector('ul.megasale_rank_list li', { timeout: 60000 });
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 1000) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 150));
        }
        window.scrollTo(0, 0);
      });
      await page.screenshot({
        path: `data/screenshots/ranking_realtime_${t.file}.jpg`,
        fullPage: true,
        type: 'jpeg',
        quality: 75,
      });
      console.log(`ranking screenshot saved (watch=${watchHits.join(',')})`);
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
          const hay = `${info.brand} ${info.shop_name}`.toLowerCase();
          const watch = watchCodes.has(it.goodscode) || watchNames.some((n) => hay.includes(n)) ? 'Y' : '';
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
