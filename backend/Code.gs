/**
 * 顏色獵人排行榜 API — Apps Script Web App 後端（T-164）
 *
 * 部署身分＝擁有者、存取＝所有人（匿名）。前端：T-164-color-hunter/index.html 的 CloudLb。
 * 由「67 獵人排行榜」後端沿用：顏色獵人找多個「底色與文字對不上」的目標格，
 * 排行榜以「找完全部目標格的用時 sec（秒，2 位小數）」由小到大排名，不需要 fast/slow（逐題統計）。
 *
 * 欄位：name | sec | errors | date | ts，四難度（beginner/easy/normal/hard）各自獨立、各留前 20 名。
 *
 * v2（2026-06-15，同步 T-152 排行榜優化）：doGet 新增 ?mode=all——一次回傳四難度榜單，
 *   讓前端開場用「1 次請求」預抓全部，之後切難度頁籤／結算判斷要不要上傳都吃這份快取，
 *   不再逐難度各打一次 API（減少 Apps Script 配額消耗、加速切頁籤）。已有的「30 秒共享快取＋
 *   滿榜最後一名短路」維持不變。
 *
 * 防濫用（擋「看一眼網址就 curl 灌假分數」的低門檻偽造，非金融級）：
 *   1. HMAC-SHA256 簽章：sig == HMAC(SECRET, "name|mode|sec|errors|ts|nonce")
 *   2. 時間窗：|now - ts| <= 10 分鐘
 *   3. nonce 防重放：CacheService 記 20 分鐘，重複 nonce 視為 replay
 *   4. 最短秒數合理性：人不可能在這個秒數內找完全部目標格（反應遊戲，門檻很低，只擋 0 秒造假）
 *
 * ⚠️ SECRET 必須等於前端 lbSecret()（index.html 的 LB_KC 每碼 XOR 90）。改任一端都要同步另一端。
 */

var SECRET = 'b9d4e1a7c2f80356e4ab19fd7c305a82e9106b4fd83c27a1';

var SS_NAME = '顏色獵人排行榜';
var MODES = { beginner: 1, easy: 1, normal: 1, hard: 1 };
// 找完全部目標格的「最短合理秒數」：反應遊戲，門檻很低，僅擋 0 秒造假；格子越多越難找、門檻略高。
var MIN_SEC = { beginner: 0.5, easy: 0.7, normal: 0.9, hard: 1.1 };
var HEADER = ['name', 'sec', 'errors', 'date', 'ts'];
var TOP_N = 20;
var TIME_WINDOW_MS = 10 * 60 * 1000;
var NONCE_TTL_SEC = 20 * 60;
var TOP_CACHE_TTL = 30;   // 榜單共享快取秒數，減少開試算表次數

// ---------- 榜單快取（CacheService 跨請求共享） ----------
function getCachedTop(mode) {
  var s = CacheService.getScriptCache().get('top_' + mode);
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}
function setCachedTop(mode, top) {
  try { CacheService.getScriptCache().put('top_' + mode, JSON.stringify(top), TOP_CACHE_TTL); } catch (e) {}
}
function clearCachedTop(mode) {
  try { CacheService.getScriptCache().remove('top_' + mode); } catch (e) {}
}

// ---------- HTTP 入口 ----------
function doGet(e) {
  try {
    var raw = e && e.parameter && e.parameter.mode;
    // ?mode=all：一次回傳全部難度榜單（前端開場預抓，對帳號仍只算 1 次請求，
    // 後端在同一次執行裡讀完 4 張表並儘量用共享快取，省下前端逐難度多次 GET）。
    if (raw === 'all') {
      var all = {};
      for (var m in MODES) {
        var c = getCachedTop(m);
        if (!c) { c = readTop(m); setCachedTop(m, c); }
        all[m] = c;
      }
      return json({ ok: true, all: all });
    }
    var mode = normMode(raw);
    if (!mode) return json({ ok: false, error: 'bad mode' });
    var cached = getCachedTop(mode);
    if (cached) return json({ ok: true, mode: mode, top: cached, cached: true });
    var top = readTop(mode);
    setCachedTop(mode, top);
    return json({ ok: true, mode: mode, top: top });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    var mode = normMode(body.mode);
    if (!mode) return json({ ok: false, error: 'bad mode' });

    var name = String(body.name == null ? '' : body.name).trim().slice(0, 8) || '玩家';
    var sec = Number(body.sec);
    var errors = Number(body.errors);
    var ts = Number(body.ts);
    var nonce = String(body.nonce || '');
    var sig = String(body.sig || '');

    if (!isFinite(sec) || sec <= 0) return json({ ok: false, error: 'bad sec' });
    if (!isFinite(errors) || errors < 0) errors = 0;
    if (!isFinite(ts) || !nonce || !sig) return json({ ok: false, error: 'missing fields' });

    // 1) 簽章（欄位順序與前端一致）
    var expect = hmacHex('' + name + '|' + mode + '|' + body.sec + '|' + body.errors + '|' + body.ts + '|' + nonce, SECRET);
    if (!safeEqual(expect, sig)) return json({ ok: false, error: 'bad sig' });

    // 2) 時間窗
    if (Math.abs(Date.now() - ts) > TIME_WINDOW_MS) return json({ ok: false, error: 'stale ts' });

    // 3) 秒數合理性
    if (sec < MIN_SEC[mode]) return json({ ok: false, error: 'bad sec' });

    // 4) nonce 防重放
    var cache = CacheService.getScriptCache();
    if (cache.get('n_' + nonce)) return json({ ok: false, error: 'replay' });
    cache.put('n_' + nonce, '1', NONCE_TTL_SEC);

    // 「最後一名」短路：滿榜時若本次秒數慢於等於快取中最後一名 → 必不進榜，不開試算表寫入。
    var cached = getCachedTop(mode);
    if (cached && cached.length >= TOP_N) {
      var cutoff = Number(cached[cached.length - 1].sec);
      if (isFinite(cutoff) && sec >= cutoff) {
        return json({ ok: true, mode: mode, top: cached, rank: null, skipped: true });
      }
    }

    var date = new Date().toISOString().slice(0, 10);

    var lock = LockService.getScriptLock();
    lock.waitLock(15000);
    var rank, top;
    try {
      var sheet = getModeSheet(mode);
      appendEntry(sheet, { name: name, sec: sec, errors: errors, date: date, ts: ts });
      top = trimAndRead(sheet);
      rank = findRank(top, name, sec);
      setCachedTop(mode, top);
    } finally {
      lock.releaseLock();
    }
    return json({ ok: true, mode: mode, top: top, rank: rank });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// ---------- 排行榜資料 ----------
function readTop(mode) { return trimAndRead(getModeSheet(mode)); }

function trimAndRead(sheet) {
  var values = sheet.getDataRange().getValues();
  var idx = headerIndex(values);
  var nameCol = idx.name, secCol = idx.sec;
  var dataRows = values.slice(1).filter(function (r) { return r[nameCol] !== '' && r[secCol] !== ''; });
  var entries = dataRows.map(function (r) { return rowToEntry(r, idx); });
  entries.sort(function (a, b) { return a.sec - b.sec; });
  if (entries.length > TOP_N) {
    var keep = entries.slice(0, TOP_N);
    rewriteEntriesCanonical(sheet, keep);
    entries = keep;
  }
  return entries.slice(0, TOP_N);
}

// 依「欄位標題」判讀（標題缺欄退回正規欄序）。
function headerIndex(values) {
  var head = (values && values[0]) ? values[0] : [];
  var idx = {};
  for (var i = 0; i < head.length; i++) {
    var key = String(head[i] == null ? '' : head[i]).trim().toLowerCase();
    if (key && idx[key] === undefined) idx[key] = i;
  }
  for (var k = 0; k < HEADER.length; k++) {
    if (idx[HEADER[k]] === undefined) idx[HEADER[k]] = k;
  }
  return idx;
}

function rowToEntry(r, idx) {
  function cell(key) {
    var i = idx[key];
    var v = (i === undefined) ? null : r[i];
    return (v === '' || v == null) ? null : v;
  }
  var nameV = cell('name');
  var dateV = cell('date');
  var date = dateV == null ? '' : (isDateObj(dateV) ? isoDate(dateV) : String(dateV).slice(0, 10));
  var errV = cell('errors');
  return {
    name: nameV == null ? '玩家' : String(nameV),
    sec: Number(cell('sec')),
    errors: errV == null ? null : Number(errV),
    date: date,
    ts: numOrNull(cell('ts'))
  };
}

function entryToRow(e, idx, width) {
  var row = [];
  for (var i = 0; i < width; i++) row.push('');
  HEADER.forEach(function (key, fallbackCol) {
    var col = idx && idx[key] !== undefined ? idx[key] : fallbackCol;
    row[col] = (e[key] == null ? '' : e[key]);
  });
  return row;
}

function appendEntry(sheet, entry) {
  var meta = ensureWriteHeader(sheet);
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, meta.width).setValues([entryToRow(entry, meta.idx, meta.width)]);
  forceNumberFormat(sheet, meta.idx);
}

// sec/ts 整欄強制純數字格式，避免被誤套日期格式。
function forceNumberFormat(sheet, idx) {
  var rows = Math.max(sheet.getMaxRows() - 1, 1);
  ['sec', 'ts'].forEach(function (k) {
    var c = (idx && idx[k] !== undefined) ? idx[k] : HEADER.indexOf(k);
    if (c >= 0) sheet.getRange(2, c + 1, rows, 1).setNumberFormat('0.############');
  });
}

function ensureWriteHeader(sheet) {
  var width = Math.max(sheet.getLastColumn(), HEADER.length);
  var head = sheet.getRange(1, 1, 1, width).getValues()[0];
  var idx = existingHeaderIndex(head);
  HEADER.forEach(function (key, preferredCol) {
    if (idx[key] !== undefined) return;
    if (head[preferredCol] == null || String(head[preferredCol]).trim() === '') {
      head[preferredCol] = key;
      idx[key] = preferredCol;
    } else {
      head.push(key);
      idx[key] = head.length - 1;
    }
  });
  sheet.getRange(1, 1, 1, head.length).setValues([head]);
  return { idx: idx, width: head.length };
}

function existingHeaderIndex(head) {
  var idx = {};
  for (var i = 0; i < head.length; i++) {
    var key = String(head[i] == null ? '' : head[i]).trim().toLowerCase();
    if (key && idx[key] === undefined) idx[key] = i;
  }
  return idx;
}

function rewriteEntriesCanonical(sheet, entries) {
  sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), HEADER.length).clearContent();
  forceNumberFormat(sheet, canonicalIndex());
  if (entries.length) sheet.getRange(2, 1, entries.length, HEADER.length).setValues(entries.map(function (e) {
    return entryToRow(e, canonicalIndex(), HEADER.length);
  }));
}

function canonicalIndex() {
  var idx = {};
  for (var i = 0; i < HEADER.length; i++) idx[HEADER[i]] = i;
  return idx;
}

function isDateObj(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }
function isoDate(d) { try { return Utilities.formatDate(d, 'GMT+8', 'yyyy-MM-dd'); } catch (e) { return ''; } }

function findRank(top, name, sec) {
  for (var i = 0; i < top.length; i++) {
    if (top[i].name === name && Number(top[i].sec) === Number(sec)) return i + 1;
  }
  return null;
}

// ---------- 試算表存取（懶建 / 復用既有同名表） ----------
function getModeSheet(mode) {
  var ss = getSS();
  var sheet = ss.getSheetByName(mode);
  if (!sheet) {
    sheet = ss.insertSheet(mode);
    sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
  } else if (sheet.getLastColumn() < HEADER.length) {
    sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
  }
  return sheet;
}

function getSS() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SS_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* 失效就重建 */ }
  }
  var ss;
  var files = DriveApp.getFilesByName(SS_NAME);
  if (files.hasNext()) ss = SpreadsheetApp.open(files.next());
  else {
    ss = SpreadsheetApp.create(SS_NAME);
    var def = ss.getSheets()[0];
    def.setName('easy');
    def.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
  }
  props.setProperty('SS_ID', ss.getId());
  return ss;
}

// ---------- 工具 ----------
function normMode(m) {
  m = String(m || '').toLowerCase();
  return MODES[m] ? m : null;
}
function numOrNull(v) {
  if (v == null || v === '') return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}
function hmacHex(msg, key) {
  // 與前端 hmacSha256Hex 一致：用 Byte[] UTF-8 overload（含中文名才簽得對）。
  var raw = Utilities.computeHmacSha256Signature(Utilities.newBlob(msg).getBytes(), Utilities.newBlob(key).getBytes());
  return raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- 維運（Apps Script 編輯器手動執行） ----------
function adminClearAll() {
  ['beginner', 'easy', 'normal', 'hard'].forEach(function (mode) {
    var sheet = getModeSheet(mode);
    var last = sheet.getLastRow();
    if (last > 1) sheet.getRange(2, 1, last - 1, HEADER.length).clearContent();
    clearCachedTop(mode);
  });
}
