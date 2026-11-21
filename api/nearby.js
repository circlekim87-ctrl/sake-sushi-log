/* =====================================================================
   api/nearby.js — 주변 업장 검색 프록시 (Vercel 서버리스 함수)
   ---------------------------------------------------------------------
   GET /api/nearby?lat=37.53&lng=127.12&radius=5
     · lat  -90 ~ 90, lng -180 ~ 180, radius 1 ~ 200 (기본 5m)
     · env KAKAO_REST_API_KEY (Vercel 대시보드 › Settings › Environment Variables)
   ---------------------------------------------------------------------
   · 카카오 로컬 category 검색(FD6 음식점 · CE7 카페)을 서버에서 호출해
     앱의 nearby.js 와 같은 모양({ name, kind, address, area, lat, lng, dist })으로 돌려준다.
   · coord2regioncode 로 동네명(area)도 함께 준다.
   · 키가 없으면 503 { error: 'not_configured' } — 앱은 이때 OpenStreetMap 으로 폴백한다.
   · 외부로 나가는 값은 좌표와 반경뿐이다.
   ===================================================================== */
'use strict';

var KAKAO_CATEGORY = 'https://dapi.kakao.com/v2/local/search/category.json';
var KAKAO_REGION = 'https://dapi.kakao.com/v2/local/geo/coord2regioncode.json';
var CATEGORY_CODES = ['FD6', 'CE7'];            // 음식점 · 카페
var RADIUS_DEFAULT = 5;
var RADIUS_MAX = 200;
var PAGE_SIZE = 15;
var UPSTREAM_TIMEOUT_MS = 8000;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function send(res, status, body) {
  cors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function num(v) {
  if (v == null || v === '') return NaN;
  var n = Number(v);
  return isFinite(n) ? n : NaN;
}
function shortCity(s) {
  return String(s || '').replace(/(특별자치시|특별자치도|특별시|광역시|도)$/, '').trim();
}
/* '서울특별시 송파구 풍납동' → '서울 송파구 풍납동' (앱의 kakaoArea 와 같은 규칙) */
function kakaoArea(addr) {
  var parts = String(addr || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return '';
  var out = [shortCity(parts[0])];
  for (var i = 1; i < parts.length && out.length < 3; i++) {
    if (/^\d/.test(parts[i])) break;
    out.push(parts[i]);
  }
  return out.join(' ').trim();
}
function haversine(a, b) {
  var R = 6371000, rad = Math.PI / 180;
  var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

async function kakaoGet(url, key) {
  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (e) { /* noop */ } }, UPSTREAM_TIMEOUT_MS);
  try {
    var res = await fetch(url, {
      headers: { Authorization: 'KakaoAK ' + key, Accept: 'application/json' },
      signal: ctrl ? ctrl.signal : undefined
    });
    var txt = await res.text();
    var json = null;
    try { json = JSON.parse(txt); } catch (e) { json = null; }
    if (!res.ok) {
      var err = new Error('kakao ' + res.status);
      err.status = res.status;
      err.json = json;
      throw err;
    }
    return json || {};
  } finally {
    clearTimeout(timer);
  }
}

function categoryUrl(code, lat, lng, radius) {
  return KAKAO_CATEGORY + '?category_group_code=' + code +
    '&x=' + encodeURIComponent(String(lng)) + '&y=' + encodeURIComponent(String(lat)) +
    '&radius=' + Math.round(radius) + '&sort=distance&size=' + PAGE_SIZE;
}
function regionUrl(lat, lng) {
  return KAKAO_REGION + '?x=' + encodeURIComponent(String(lng)) +
    '&y=' + encodeURIComponent(String(lat));
}

/* 카카오 documents → 앱 형식. 반경 밖은 버리고 가까운 순으로 정렬한다. */
function toPlaces(json, lat, lng, radius) {
  var docs = (json && json.documents) || [];
  var out = [];
  docs.forEach(function (d) {
    var name = String(d.place_name || '').trim();
    if (!name) return;
    var plat = parseFloat(d.y), plng = parseFloat(d.x);
    if (!isFinite(plat) || !isFinite(plng)) return;
    var given = parseFloat(d.distance);
    var dist = isFinite(given) ? given : haversine({ lat: lat, lng: lng }, { lat: plat, lng: plng });
    if (dist > radius) return;
    var road = String(d.road_address_name || '').trim();
    out.push({
      name: name,
      kind: String(d.category_name || '').split('>').pop().trim(),
      address: road || String(d.address_name || '').trim(),
      area: kakaoArea(d.address_name || road),
      lat: plat,
      lng: plng,
      dist: Math.round(dist * 10) / 10
    });
  });
  out.sort(function (a, b) { return a.dist - b.dist; });
  return out;
}
function mergePlaces(list) {
  var seen = {}, out = [];
  (list || []).forEach(function (p) {
    var k = String(p.name).replace(/\s+/g, '').toLowerCase();
    if (seen[k]) return;
    seen[k] = 1;
    out.push(p);
  });
  out.sort(function (a, b) { return a.dist - b.dist; });
  return out.slice(0, 8);                          // 앱의 nearbyMerge 와 같은 상한
}
function regionArea(json) {
  var docs = (json && json.documents) || [];
  var pick = null;
  for (var i = 0; i < docs.length; i++) {
    if (docs[i] && docs[i].region_type === 'B') { pick = docs[i]; break; }
  }
  if (!pick) pick = docs[0] || null;
  if (!pick) return { area: '', address: '' };
  var parts = [shortCity(pick.region_1depth_name), pick.region_2depth_name, pick.region_3depth_name]
    .filter(Boolean);
  var area = parts.join(' ').trim() || kakaoArea(pick.address_name);
  return { area: area, address: String(pick.address_name || '').trim() };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    send(res, 405, { error: 'method_not_allowed' });
    return;
  }
  var key = String(process.env.KAKAO_REST_API_KEY || '').trim();
  if (!key) {
    send(res, 503, { error: 'not_configured' });
    return;
  }
  var q = req.query || {};
  if (!req.query && req.url) {                     // query 파서가 없는 환경 대비
    var qs = String(req.url).split('?')[1] || '';
    q = {};
    qs.split('&').forEach(function (pair) {
      if (!pair) return;
      var kv = pair.split('=');
      q[decodeURIComponent(kv[0] || '')] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
    });
  }
  var lat = num(q.lat), lng = num(q.lng);
  var radius = num(q.radius);
  if (!isFinite(radius) || radius <= 0) radius = RADIUS_DEFAULT;
  radius = Math.max(1, Math.min(RADIUS_MAX, radius));
  if (!isFinite(lat) || lat < -90 || lat > 90) {
    send(res, 400, { error: 'bad_lat' });
    return;
  }
  if (!isFinite(lng) || lng < -180 || lng > 180) {
    send(res, 400, { error: 'bad_lng' });
    return;
  }

  var lists = [], region = null, failure = null;
  try {
    var results = await Promise.all(CATEGORY_CODES.map(function (code) {
      return kakaoGet(categoryUrl(code, lat, lng, radius), key)
        .then(function (json) { return toPlaces(json, lat, lng, radius); })
        .catch(function (e) { failure = failure || e; return []; });
    }));
    results.forEach(function (l) { lists = lists.concat(l); });
  } catch (e) {
    failure = failure || e;
  }
  if (!lists.length && failure) {
    var st = failure.status || 0;
    if (st === 401 || st === 403) {
      send(res, 502, { error: 'upstream_auth', message: '카카오 REST API 키를 확인해 주세요.' });
      return;
    }
    send(res, 502, { error: 'upstream', status: st, message: String(failure.message || 'kakao') });
    return;
  }
  try {
    region = regionArea(await kakaoGet(regionUrl(lat, lng), key));
  } catch (e) {
    region = null;                                  // 동네명은 없어도 된다
  }
  var places = mergePlaces(lists);
  send(res, 200, {
    ok: true,
    src: '카카오',
    radius: Math.round(radius),
    places: places,
    area: (region && region.area) || (places[0] && places[0].area) || '',
    address: (region && region.address) || ''
  });
};

/* 테스트용 */
module.exports.__toPlaces = toPlaces;
module.exports.__regionArea = regionArea;
module.exports.__kakaoArea = kakaoArea;
module.exports.__categoryUrl = categoryUrl;
