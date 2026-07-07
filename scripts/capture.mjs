// Qoo10 Megapo capture (GitHub Actions)
// mode 'ranking'   : sid=22 realtime ranking -> cumulative CSV (+product enrichment) + gzipped HTML + watch screenshots
// mode 'screenshot': sid=1422 event main page -> full-page JPEG
import { chromium } from 'playwright';
import fs from 'node:fs';
import zlib from 'node:zlib';

const RANKING_URL = 'https://www.qoo10.jp/gmkt.inc/Special/Special.aspx?sid=22';
const EVENT_URL = 'https://www.qoo10.jp/gmkt.inc/Special/Special.aspx?sid=1422';
const GOODS_URL = (code) => `https://www.qoo10.jp/gmkt.inc/goods/goods.aspx?goodscode=${code}`;
const ENRICH_TTL_HOURS = 3;
const CACHE_PATH = 'data/product_cache.json';
const LASTRUN_PATH = 'data/last_run.json';
const CUM_PATH = 'data/cumulative.csv';
const WATCH_PATH = 'watch_goodscodes.txt';

const HEADER = [
  'captured_date', 'captured_time', 'rank', 'goodscode', 'title', 'list_price_yen',
  'shop_id', 'shop_name', 'brand', 'ref_price_yen', 'sell_price_yen',
  'timesale_price_yen', 'timesale_hours', 'megapo_coupon_pct', 'megapoint',
  'watch', 'prev_rank', 'change', 'url',
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
    sell_price_yen: pick(/id="dl_sell_price"[\s\S]{0,300}?data-price="(\d+)"/),
    timesale_price_yen: pick(/タイムセール価格<\/strong><\/dt>\s*<dd><strong data-price="(\d+)"/),
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

  if (mode === 'screenshot') {
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

    // watch list
    const watchSet = new Set();
    if (fs.existsSync(WATCH_PATH)) {
      for (const line of fs.readFileSync(WATCH_PATH, 'utf8').split(/\r?\n/)) {
        if (/^\d+$/.test(line.trim())) watchSet.add(line.trim());
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
      const watch = watchSet.has(it.goodscode) ? 'Y' : '';
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
      };
    });

    // append to single cumulative CSV
    const body = rows.map((r) => HEADER.map((h) => csvField(r[h])).join(',')).join('\r\n') + '\r\n';
    if (!fs.existsSync(CUM_PATH)) {
      fs.writeFileSync(CUM_PATH, '﻿' + HEADER.join(',') + '\r\n' + body); // BOM for Excel
    } else {
      fs.appendFileSync(CUM_PATH, body);
    }

    const ranks = {};
    for (const it of items) ranks[it.goodscode] = it.rank;
    fs.writeFileSync(LASTRUN_PATH, JSON.stringify({ captured: `${t.date} ${t.hm}`, ranks }));

    // watch-hit screenshot of the ranking page
    if (watchHits.length > 0) {
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
      console.log(`watch screenshot saved (${watchHits.join(',')})`);
    }

    console.log(
      `ranking saved: ${rows.length} items at ${t.date} ${t.hm} JST (new ${newCnt} / up ${upCnt} / down ${downCnt}, enriched ${fetched}, failed ${failed}, watch ${watchHits.length})`
    );
  }
} finally {
  await browser.close();
}
