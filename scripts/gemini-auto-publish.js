/**
 * scripts/gemini-auto-publish.js
 *
 * 1. 간추린 뉴스: 8대 분야 청크 병렬 검색 (실시간 팩트 기사 수집)
 *    - Google Search grounding 메타데이터와 대조해 실제 검색되지 않은 URL/기사는 제외
 *    - 신뢰 언론사 화이트리스트(약 100곳) 도메인과 source 표기가 일치하는지 검증
 *    - 게재 후 48시간 이내 기사만 채택 (개수 미달 시 억지로 채우지 않음)
 * 2. 주식 모닝 브리핑: yahoo-finance2 실시간 지수 수치 확정 주입 + Gemini 시황/전략 분석
 * 3. 데일리 인사이트: 최근 30일 중복 검증 & 자동 재시도(Retry) 파이프라인
 *
 * 실행 옵션:
 *   node scripts/gemini-auto-publish.js stock    # 주식 모닝 브리핑
 *   node scripts/gemini-auto-publish.js news     # 간추린 뉴스
 *   node scripts/gemini-auto-publish.js insight  # 데일리 인사이트
 *   node scripts/gemini-auto-publish.js all      # 3대 콘텐츠 전체 순차 발행 (기본값)
 */

const { loadEnvConfig } = require('@next/env');
loadEnvConfig(process.cwd());

const { GoogleGenAI, Type } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

// 1. 환경 변수 검증
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim().replace(/^["']|["']$/g, '');
let rawUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '').trim().replace(/^["']|["']$/g, '');
const SUPABASE_SERVICE_ROLE_KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_KEY || ''
).trim().replace(/^["']|["']$/g, '');

if (rawUrl && !rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
  rawUrl = `https://${rawUrl}`;
}
const SUPABASE_URL = rawUrl;

if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ 필수 환경 변수가 누락되었습니다: GEMINI_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// 2. 인스턴스 초기화
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { createClient: false }
});

// 💡 8대 뉴스 섹션별 전용 검색 쿼리 설정
const NEWS_SECTIONS_CONFIG = [
  { id: 'sec_1', category: '[美미국]', icon: 'Globe', searchFocus: '오늘 미국 주요 뉴스 정치 경제 외교 현지 외신 US news headlines' },
  { id: 'sec_2', category: '[中중국,대만]', icon: 'Globe', searchFocus: '오늘 중국 대만 주요 뉴스 양안관계 경제 정책 외신' },
  { id: 'sec_3', category: '[러시아,우크라이나,이스라엘,이란,북한]', icon: 'Globe', searchFocus: '러시아 우크라이나 전쟁 이스라엘 이란 중동 북한 미사일 안보 외신' },
  { id: 'sec_4', category: '[英영국,佛프랑스,獨독일]', icon: 'Globe', searchFocus: '영국 프랑스 독일 유럽연합 EU 주요 뉴스 외신 UK France Germany headlines' },
  { id: 'sec_5', category: '[日일본]', icon: 'Globe', searchFocus: '일본 오늘 주요 뉴스 엔화 경제 정치 사회 현지 보도' },
  { id: 'sec_6', category: '[한국.정치.사회]', icon: 'Globe', searchFocus: '오늘 한국 주요 정치 사회 톱뉴스 정부 국회 정책 사건사고 헤드라인' },
  { id: 'sec_7', category: '[한국.경제]', icon: 'TrendingUp', searchFocus: '오늘 한국 경제 금융 부동산 증시 기업 실적 주요 경제 뉴스' },
  { id: 'sec_8', category: '[스포츠:이정후.안세영.KLPGA.PBA]', icon: 'Sparkles', searchFocus: '오늘 스포츠 주요 뉴스 이정후 MLB 안세영 골프 PBA 당구 손흥민 프로야구 KBO' }
];

// 💡 신뢰 언론사 화이트리스트 (약 100개) — source 표기와 실제 도메인 대조용
// key: Gemini가 응답에 적을 것으로 기대하는 언론사 표기, value: 해당 언론사의 실제 도메인(들)
const TRUSTED_DOMAINS = {
  // ── 한국 통신/방송/종합일간지 ──
  '연합뉴스': ['yna.co.kr'],
  '연합뉴스TV': ['yonhapnewstv.co.kr'],
  '뉴시스': ['newsis.com'],
  '뉴스1': ['news1.kr'],
  '조선일보': ['chosun.com'],
  '중앙일보': ['joongang.co.kr', 'joins.com'],
  '동아일보': ['donga.com'],
  '한국일보': ['hankookilbo.com'],
  '경향신문': ['khan.co.kr'],
  '한겨레': ['hani.co.kr'],
  '서울신문': ['seoul.co.kr'],
  '국민일보': ['kmib.co.kr'],
  '문화일보': ['munhwa.com'],
  '세계일보': ['segye.com'],
  '내일신문': ['naeil.com'],
  'KBS': ['news.kbs.co.kr', 'kbs.co.kr'],
  'MBC': ['imnews.imbc.com', 'imbc.com'],
  'SBS': ['news.sbs.co.kr'],
  'JTBC': ['news.jtbc.co.kr'],
  'TV조선': ['tvchosun.com'],
  '채널A': ['ichannela.com', 'news.ichannela.com'],
  'MBN': ['mbn.co.kr'],
  'YTN': ['ytn.co.kr'],
  '노컷뉴스': ['nocutnews.co.kr'],
  '프레시안': ['pressian.com'],
  '오마이뉴스': ['ohmynews.com'],
  '데일리안': ['dailian.co.kr'],
  '뉴데일리': ['newdaily.co.kr'],
  '아이뉴스24': ['inews24.com'],
  '메트로신문': ['metroseoul.co.kr'],
  '공정뉴스': ['fairnews.co.kr'],
  '아주경제': ['ajunews.com'],
  'SBS Biz': ['biz.sbs.co.kr'],
  '한국금융신문': ['fntimes.com'],
  '코리아중앙데일리': ['koreajoongangdaily.joins.com'],
  '더구루': ['theguru.co.kr'],

  // ── 경제/증권 매체 ──
  '매일경제': ['mk.co.kr'],
  '한국경제': ['hankyung.com', 'wowtv.co.kr'],
  '헤럴드경제': ['heraldcorp.com'],
  '이데일리': ['edaily.co.kr'],
  '머니투데이': ['mt.co.kr'],
  '아시아경제': ['asiae.co.kr'],
  '파이낸셜뉴스': ['fnnews.com'],
  '뉴스핌': ['newspim.com'],
  '이투데이': ['etoday.co.kr'],
  '전자신문': ['etnews.com'],
  'ZDNet Korea': ['zdnet.co.kr'],
  '디지털타임스': ['dt.co.kr'],
  '블로터': ['bloter.net'],
  '디일렉': ['thelec.kr'],
  'AI타임스': ['aitimes.com'],
  '글로벌이코노믹': ['g-enews.com'],
  '조세일보': ['joseilbo.com'],
  '연합인포맥스': ['yonhapinfomax.co.kr'],
  '자본시장뉴스': ['capitalmarket.co.kr'],
  '알파경제': ['alphabiz.co.kr'],
  '경기일보': ['kyeonggi.com'],
  '강원일보': ['kwnews.co.kr'],
  '부산일보': ['busan.com'],
  '매일신문': ['imaeil.com'],
  '영남일보': ['yeongnam.com'],
  '광주일보': ['kwangju.co.kr'],
  '충청투데이': ['cctoday.co.kr'],
  '대전일보': ['daejonilbo.com'],
  '이코노미스트(한국)': ['economist.co.kr'],
  '한국금융경제신문': ['kfenews.com'],

  // ── 스포츠/연예 매체 ──
  '스포츠서울': ['sportsseoul.com'],
  '스타뉴스': ['starnewskorea.com'],
  '엑스포츠뉴스': ['xportsnews.com'],
  '일간스포츠': ['isplus.com'],
  'OSEN': ['osen.co.kr'],
  '스포츠조선': ['sportschosun.com'],
  '마이데일리': ['mydaily.co.kr'],

  // ── 미국 ──
  '로이터': ['reuters.com'],
  '블룸버그': ['bloomberg.com'],
  'AP': ['apnews.com'],
  'AFP': ['afp.com'],
  'CNN': ['cnn.com'],
  'NYT': ['nytimes.com'],
  '뉴욕타임스': ['nytimes.com'],
  'WSJ': ['wsj.com'],
  '월스트리트저널': ['wsj.com'],
  '워싱턴포스트': ['washingtonpost.com'],
  'NPR': ['npr.org'],
  'ABC뉴스': ['abcnews.go.com'],
  'NBC뉴스': ['nbcnews.com'],
  'CBS뉴스': ['cbsnews.com'],
  '폭스뉴스': ['foxnews.com'],
  '폴리티코': ['politico.com'],
  '액시오스': ['axios.com'],
  'USA투데이': ['usatoday.com'],
  'LA타임스': ['latimes.com'],
  '타임': ['time.com'],
  '뉴스위크': ['newsweek.com'],
  '포브스': ['forbes.com'],
  '비즈니스인사이더': ['businessinsider.com'],
  'CNBC': ['cnbc.com'],
  '마켓워치': ['marketwatch.com'],
  '야후뉴스': ['news.yahoo.com', 'finance.yahoo.com'],
  '테크크런치': ['techcrunch.com'],
  '더버지': ['theverge.com'],
  '와이어드': ['wired.com'],

  // ── 유럽 ──
  'BBC': ['bbc.com', 'bbc.co.uk'],
  '가디언': ['theguardian.com'],
  '파이낸셜타임스': ['ft.com'],
  '이코노미스트': ['economist.com'],
  '스카이뉴스': ['news.sky.com'],
  'ITV뉴스': ['itv.com'],
  '도이체벨레': ['dw.com'],
  '슈피겔': ['spiegel.de'],
  '르몽드': ['lemonde.fr'],
  '타스': ['tass.com'],
  '리아노보스티': ['ria.ru'],
  '인테르팍스': ['interfax.com', 'interfax.ru'],

  // ── 일본 ──
  '니혼게이자이': ['nikkei.com'],
  '아사히신문': ['asahi.com'],
  '요미우리신문': ['yomiuri.co.jp'],
  '마이니치신문': ['mainichi.jp'],
  '교도통신': ['kyodonews.net'],
  'NHK': ['nhk.or.jp'],
  '재팬타임스': ['japantimes.co.jp'],
  '퍼시픽 리그.com': ['pacificleague.com'],

  // ── 중국/대만/중동 ──
  '신화통신': ['xinhuanet.com', 'news.cn'],
  '인민일보': ['people.com.cn'],
  '글로벌타임스': ['globaltimes.cn'],
  'CCTV': ['cctv.com'],
  'SCMP': ['scmp.com'],
  '타이베이타임스': ['taipeitimes.com'],
  '중앙통신사(대만)': ['focustaiwan.tw'],
  '알자지라': ['aljazeera.com'],
  '타임스오브이스라엘': ['timesofisrael.com'],
  '하레츠': ['haaretz.com']
};

// 3. 한국 표준시(KST) 날짜 계산
function getKSTDateInfo(targetDateStr) {
  let dateObj = new Date();

  if (targetDateStr) {
    const cleaned = String(targetDateStr).trim();
    if (/^\d{8}$/.test(cleaned)) {
      const y = cleaned.slice(0, 4);
      const m = cleaned.slice(4, 6);
      const d = cleaned.slice(6, 8);
      dateObj = new Date(`${y}-${m}-${d}T12:00:00+09:00`);
    } else {
      dateObj = new Date(`${cleaned}T12:00:00+09:00`);
    }
  }

  const formatter = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short'
  });

  const parts = formatter.formatToParts(dateObj);
  const map = {};
  parts.forEach(p => (map[p.type] = p.value));

  const yyyy = map.year;
  const mm = String(map.month).padStart(2, '0');
  const dd = String(map.day).padStart(2, '0');
  const weekday = map.weekday;
  const shortYear = yyyy.slice(-2);

  const isWeekendClosed = weekday === '일' || weekday === '월';

  return {
    isoDate: `${yyyy}-${mm}-${dd}`,
    weekday: weekday,
    isWeekendClosed: isWeekendClosed,
    titleStock: `${yyyy}년 ${parseInt(mm)}월 ${parseInt(dd)}일(${weekday}) 주식 모닝 브리핑`,
    titleNews: `${yyyy}년 ${parseInt(mm)}월 ${parseInt(dd)}일(${weekday}) 간추린 뉴스`,
    headerStock: `'${shortYear}-${parseInt(mm)}/${parseInt(dd)}(${weekday})`,
    headerNews: `'${shortYear}-${parseInt(mm)}/${parseInt(dd)}(${weekday})`,
    headerInsight: `'${shortYear}-${parseInt(mm)}/${parseInt(dd)}(${weekday})`
  };
}

// 4. Supabase 연동용 JSON 스키마 (인사이트용)
const briefingResponseSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: '브리핑 표준 제목' },
    weather: { type: Type.STRING, description: '마켓 요약 또는 날씨/테마 한 줄 요약' },
    highlights: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '핵심 3줄 요약'
    },
    sections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          category: { type: Type.STRING },
          icon: { type: Type.STRING },
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                text: { type: Type.STRING },
                source: { type: Type.STRING }
              },
              required: ['text', 'source']
            }
          }
        },
        required: ['id', 'category', 'icon', 'items']
      }
    }
  },
  required: ['title', 'weather', 'highlights', 'sections']
};

// 💡 안전한 JSON 추출 헬퍼 함수
function extractJson(rawText) {
  if (!rawText) throw new Error('AI 응답이 비어있습니다.');
  const match = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const jsonStr = match ? match[1].trim() : rawText.trim();
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      return JSON.parse(jsonStr.substring(firstBrace, lastBrace + 1));
    }
    const firstBracket = jsonStr.indexOf('[');
    const lastBracket = jsonStr.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket !== -1) {
      return JSON.parse(jsonStr.substring(firstBracket, lastBracket + 1));
    }
    throw e;
  }
}

// 💡 URL에서 도메인만 추출 (www. 접두어 제거)
function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

// 💡 [중요] Gemini googleSearch grounding의 groundingChunks[].web.uri는 실제 기사 URL이 아니라
// 구글 자체의 리다이렉트 프록시 링크(예: vertexaisearch.cloud.google.com/grounding-api-redirect/...)입니다.
// 그래서 이 링크의 "도메인"을 직접 화이트리스트와 비교하면 절대 매칭될 수 없습니다.
// 실제 도메인을 알려면 이 리다이렉트를 서버에서 직접 따라가(fetch) 최종 URL을 확인해야 합니다.
const REDIRECT_DOMAIN_CACHE = new Map();

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

// 💡 네이버뉴스/다음뉴스 등 포털 도메인 — 한국 뉴스의 상당수가 원 언론사 도메인이 아니라
// 이 포털 syndication 페이지로 검색되므로, 도메인만으로는 원 언론사를 판별할 수 없다.
// 이 경우 페이지 내용(og:site_name, 본문 등)을 직접 확인해 원 언론사 표기를 대조한다.
const AGGREGATOR_DOMAINS = ['naver.com', 'daum.net', 'news.google.com', 'google.com'];

function isAggregatorDomain(domain) {
  if (!domain) return false;
  return AGGREGATOR_DOMAINS.some(d => domain === d || domain.endsWith(`.${d}`));
}

async function resolveRedirectTarget(uri) {
  if (!uri) return null;
  if (REDIRECT_DOMAIN_CACHE.has(uri)) return REDIRECT_DOMAIN_CACHE.get(uri);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    let res;
    try {
      res = await fetch(uri, { method: 'HEAD', redirect: 'follow', signal: controller.signal, headers: BROWSER_HEADERS });
    } catch {
      // 일부 서버는 HEAD를 거부하므로 GET으로 재시도
      res = await fetch(uri, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: BROWSER_HEADERS });
    }
    const finalUrl = res.url || uri;
    const result = { url: finalUrl, domain: getDomain(finalUrl) || getDomain(uri) };
    REDIRECT_DOMAIN_CACHE.set(uri, result);
    return result;
  } catch (err) {
    const result = { url: null, domain: null };
    REDIRECT_DOMAIN_CACHE.set(uri, result);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// 💡 응답에 포함된 모든 grounding 청크의 리다이렉트를 실제 {url, domain}으로 해석 (인덱스 순서 그대로 유지)
async function resolveGroundingChunkTargets(response) {
  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  return Promise.all(chunks.map(c => resolveRedirectTarget(c?.web?.uri)));
}

// 💡 원문 텍스트(response.text, 즉 JSON 원본 문자열) 안에서 item.text가 실제로 위치한 구간을 찾는다.
// JSON.parse된 값과 원본 문자열의 이스케이프 방식이 다를 수 있어 두 가지 방식으로 시도한다.
function locateSegment(rawText, value) {
  if (!rawText || !value) return null;
  let idx = rawText.indexOf(value);
  if (idx !== -1) return { start: idx, end: idx + value.length };

  const escaped = JSON.stringify(value).slice(1, -1);
  idx = rawText.indexOf(escaped);
  if (idx !== -1) return { start: idx, end: idx + escaped.length };

  return null;
}

// 💡 특정 문장(item.text)을 실제로 뒷받침하는 grounding 청크의 (해석된) {url, domain} 목록을 구한다.
// groundingSupports는 "이 문장 구간은 이 청크(들)에서 근거했다"는 매핑 정보를 제공한다 (문장 단위 인용 근거).
function getSupportingTargets(response, resolvedChunkTargets, text) {
  const supports = response?.candidates?.[0]?.groundingMetadata?.groundingSupports;

  // groundingSupports 자체가 없는 응답이면(모델/버전에 따라 생략될 수 있음) 문장 단위 매칭이 불가능하므로
  // 이 섹션 응답 전체에서 실제로 검색된 대상으로 완화해서 검증한다 (그래도 "실제 검색되지 않은 도메인"은 여전히 걸러진다).
  if (!Array.isArray(supports) || supports.length === 0) {
    return { targets: resolvedChunkTargets.filter(t => t?.domain), precise: false };
  }

  const seg = locateSegment(response.text, text);
  if (!seg) {
    return { targets: [], precise: true };
  }

  const relevant = supports.filter(s => {
    const seg2 = s?.segment;
    if (!seg2) return false;
    const segStart = seg2.startIndex ?? 0;
    const segEnd = seg2.endIndex ?? segStart;
    return segStart < seg.end && segEnd > seg.start;
  });

  const chunkIndices = new Set();
  relevant.forEach(s => (s.groundingChunkIndices || []).forEach(i => chunkIndices.add(i)));

  const targets = [...chunkIndices].map(i => resolvedChunkTargets[i]).filter(t => t?.domain);
  return { targets, precise: true };
}

// 💡 포털(네이버/다음) syndication 페이지의 실제 원문 HTML을 가져와 og:site_name / 본문에서
// 언론사 표기를 직접 확인한다. 도메인만으로 판별 불가능한 경우의 2차 검증 수단.
const PAGE_CONTENT_CACHE = new Map();

async function fetchPageOutletHints(url) {
  if (!url) return '';
  if (PAGE_CONTENT_CACHE.has(url)) return PAGE_CONTENT_CACHE.get(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: BROWSER_HEADERS });
    const html = await res.text();
    // og:site_name, title 태그 등 언론사 표기가 나올 만한 부분만 추출 (전체를 다 검사할 필요는 없음)
    const ogSiteMatch = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
    const titleMatch = html.match(/<title>([^<]{0,200})<\/title>/i);
    const hints = [ogSiteMatch?.[1], titleMatch?.[1], html.slice(0, 3000)].filter(Boolean).join(' ');
    PAGE_CONTENT_CACHE.set(url, hints);
    return hints;
  } catch (err) {
    PAGE_CONTENT_CACHE.set(url, '');
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

// 💡 뉴스 항목 검증 (비동기): (1) source가 화이트리스트에 있는가
// (2) 원 언론사 도메인에서 직접 검색됐거나, (3) 포털(네이버/다음) 경유라면 페이지 내용에서 해당 언론사 표기가 실제로 확인되는가
async function validateNewsItem(item, supportingTargets) {
  if (!item?.text || !item?.source) {
    return { ok: false, reason: 'missing_field' };
  }

  const allowedDomains = TRUSTED_DOMAINS[item.source];
  if (!allowedDomains) {
    return { ok: false, reason: 'unknown_outlet' };
  }

  if (!supportingTargets || supportingTargets.length === 0) {
    return { ok: false, reason: 'no_grounding_support' };
  }

  // (2) 원 언론사 도메인과 직접 일치
  const directMatch = supportingTargets.some(t =>
    allowedDomains.some(ad => t.domain === ad || t.domain.endsWith(`.${ad}`))
  );
  if (directMatch) return { ok: true, via: 'direct_domain' };

  // (3) 포털 경유 — 실제 페이지 내용에서 언론사 표기를 확인
  const aggregatorTargets = supportingTargets.filter(t => isAggregatorDomain(t.domain));
  for (const t of aggregatorTargets) {
    const hints = await fetchPageOutletHints(t.url);
    if (!hints) continue;
    const mentionsOutlet =
      hints.includes(item.source) ||
      allowedDomains.some(ad => hints.includes(ad));
    if (mentionsOutlet) return { ok: true, via: 'aggregator_content_check' };
  }

  return { ok: false, reason: 'source_domain_mismatch' };
}

// 5. Yahoo Finance 실제 종가 및 등락률 정밀 계산 함수
async function fetchMarketData(dateInfo) {
  console.log(`📈 [Yahoo Finance] 7대 주요 지표 실제 시세 및 등락률 수집 중...`);

  const tickers = {
    dow: '^DJI',
    sp500: '^GSPC',
    nasdaq: '^IXIC',
    russell: '^RUT',
    sox: '^SOX',
    ewy: 'EWY',
    usdkrw: 'KRW=X'
  };

  const results = {};

  for (const [key, symbol] of Object.entries(tickers)) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      const meta = result?.meta;
      const closes = result?.indicators?.quote?.[0]?.close?.filter(c => c !== null && c !== undefined) || [];

      let currentPrice = meta?.regularMarketPrice;
      let prevClose = meta?.previousClose;

      if (closes.length >= 2) {
        currentPrice = currentPrice || closes[closes.length - 1];
        prevClose = closes[closes.length - 2];
      } else if (!prevClose && closes.length === 1) {
        prevClose = closes[0];
      }

      const changePercent = (prevClose && prevClose !== 0)
        ? ((currentPrice - prevClose) / prevClose) * 100
        : 0;

      const sign = changePercent > 0 ? '+' : '';
      const formattedPrice = currentPrice >= 100
        ? currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : currentPrice.toFixed(2);
      const formattedChange = `${sign}${changePercent.toFixed(2)}%`;

      results[key] = {
        symbol,
        price: formattedPrice,
        change: formattedChange
      };
    } catch (err) {
      console.warn(`  ⚠️ [Yahoo Finance] ${symbol} 조회 실패 (${err.message})`);
      results[key] = { symbol, price: '조회중', change: '0.00%' };
    }
  }

  console.log(`  ✓ 다우: ${results.dow.price} (${results.dow.change}) | S&P500: ${results.sp500.price} (${results.sp500.change}) | 나스닥: ${results.nasdaq.price} (${results.nasdaq.change})`);
  console.log(`  ✓ 반도체: ${results.sox.price} (${results.sox.change}) | EWY: ${results.ewy.price} (${results.ewy.change}) | 환율: ${results.usdkrw.price}원 (${results.usdkrw.change})`);

  return results;
}

// 6. [간추린 뉴스] 단일 섹션 팩트 검색 (그라운딩 검증 포함)
async function generateSingleNewsSection(secConfig, dateInfo) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const kstFormatter = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short'
  });

  const trustedOutletList = Object.keys(TRUSTED_DOMAINS).join(', ');

  const prompt = `
당신은 사실(Fact) 검증을 최우선으로 하는 전문 뉴스 에디터입니다. 반드시 Google Search 도구로 실제 검색되는 기사만 근거로 삼으십시오. 절대 기억이나 추정으로 기사를 지어내지 마십시오.

[시간 제약 - 엄격 준수]
- 현재 기준 시각: ${kstFormatter.format(now)} (KST)
- 채택 가능 기사 게재 시각: ${kstFormatter.format(cutoff)} 이후 (최근 48시간 이내)
- 검색 결과에서 게재 시각을 확인할 수 없는 기사는 사용하지 마십시오.
- 48시간보다 오래된 기사이거나, 검증되지 않는 내용은 절대 포함하지 마십시오.
- 검증 가능한 기사가 5개 미만이면 억지로 5개를 채우지 말고, 확보된 개수만 반환하십시오. 개수를 채우기 위한 추측·각색·재구성은 금지합니다.

[검색 타깃 분야]: ${secConfig.category}
[검색 키워드 힌트]: "${secConfig.searchFocus}", "${dateInfo.isoDate}"

[source 표기 규칙 - 중요]
source에는 실제 검색된 기사가 게재된 언론사명을 아래 목록에 있는 표기와 정확히 동일하게 적으십시오 (다른 표기, 축약, 오타 금지):
${trustedOutletList}
위 목록에 있는 언론사가 검색되지 않았다면 그 사실 자체를 다른 언론사로 대체하지 말고, 검증 가능한 기사만 남기십시오.

[항목별 필수 필드]
1. text: 팩트 뉴스 요약 문장. 명사/명사형 종결(~발표, ~기록, ~추진, ~논란, ~승리, ~전망 등)로 간결하게 작성 (~함, ~임 종결 금지)
2. source: 위 목록 중 실제로 검색된 언론사명 (목록 표기와 정확히 일치)

[스포츠 섹션 예외]: 지정 선수의 당일 경기 소식이 없으면 KBO, EPL, 국내 골프 등 오늘자 가장 뜨거운 스포츠 팩트 기사로 대체하되, 위 시간/검증 제약은 동일하게 적용할 것.

반드시 아래 JSON 형식으로만 응답하세요 (다른 설명 금지):
\`\`\`json
{
  "id": "${secConfig.id}",
  "category": "${secConfig.category}",
  "icon": "${secConfig.icon}",
  "items": [
    { "text": "팩트 뉴스 요약 문장", "source": "실제 언론사명" }
  ]
}
\`\`\``;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      temperature: 0.0,
      tools: [{ googleSearch: {} }]
    }
  });

  const parsed = extractJson(response.text);

  // 리다이렉트 프록시 링크를 실제 {url, domain}으로 해석 (섹션당 grounding 청크 수만큼 네트워크 요청)
  const resolvedChunkTargets = await resolveGroundingChunkTargets(response);

  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  const checked = await Promise.all(rawItems.map(async item => {
    const { targets, precise } = getSupportingTargets(response, resolvedChunkTargets, item?.text);
    const result = await validateNewsItem(item, targets);
    return { item, result, precise, targets };
  }));
  const accepted = checked.filter(c => c.result.ok).map(c => c.item);
  const rejected = checked.filter(c => !c.result.ok);

  if (rejected.length > 0) {
    console.warn(`  ⚠️ [${secConfig.category}] ${rejected.length}건 검증 실패로 제외:`);
    rejected.forEach(r => {
      const preview = (r.item?.text || '(텍스트 없음)').slice(0, 40);
      const mode = r.precise ? '문장단위' : '섹션전체(완화)';
      const src = r.item?.source || '(source 없음)';
      const resolvedDomains = (r.targets || []).map(t => t.domain).join(', ') || '(없음)';
      console.warn(`     - [${src}] "${preview}..." → 사유: ${r.result.reason} [${mode}] | 실제 해석된 도메인: ${resolvedDomains}`);
    });
  }

  if (accepted.length === 0) {
    console.warn(`  ⚠️ [${secConfig.category}] 검증을 통과한 기사가 0건입니다. 이번 회차는 해당 섹션이 빈 상태로 발행됩니다.`);
  }

  return {
    id: parsed.id || secConfig.id,
    category: parsed.category || secConfig.category,
    icon: parsed.icon || secConfig.icon,
    // 최종 저장 포맷은 기존과 동일하게 text/source만 유지
    items: accepted.map(({ text, source }) => ({ text, source }))
  };
}

// 7. [간추린 뉴스] 날씨 및 메타 요약
async function generateNewsMeta(dateInfo, sections) {
  const sampleHeadlines = sections
    .flatMap(s => (s?.items ? s.items.slice(0, 2).map(i => i.text) : []))
    .filter(Boolean)
    .join('\n');

  const prompt = `
오늘(${dateInfo.isoDate}) 대한민국 전국 날씨를 Google Search로 검색하고, 아래 수집된(이미 검증된) 오늘자 주요 뉴스 헤드라인을 바탕으로 [간추린 뉴스]의 날씨와 3줄 하이라이트를 작성하세요. 아래 목록에 없는 새로운 사실을 지어내지 말고, 반드시 주어진 헤드라인 범위 내에서만 하이라이트를 구성하세요.

[오늘자 수집된 주요 뉴스 샘플]:
${sampleHeadlines}

[작성 규칙]:
1. weather: 오늘 전국 날씨/기온 한 줄 요약 (명사형 종결)
2. highlights: 위 목록 중 가장 주목할 톱 헤드라인 3개 (각 1문장, 명사형 종결, 목록에 있는 사실만 사용)

반드시 아래 JSON 형식으로만 응답하세요:
\`\`\`json
{
  "weather": "날씨 한 줄 요약",
  "highlights": ["핵심 헤드라인 1", "핵심 헤드라인 2", "핵심 헤드라인 3"]
}
\`\`\``;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      temperature: 0.0,
      tools: [{ googleSearch: {} }]
    }
  });

  return extractJson(response.text);
}

// 8. [주식 모닝 브리핑] 시스템 프롬프트 (Yahoo Finance 수치 연동)
function getStockSystemPrompt(dateInfo, marketData) {
  const isWeekend = dateInfo.isWeekendClosed;
  const weekendTag = isWeekend ? '[직전 거래일 마감] ' : '';

  return `
당신은 매일 개장 전 글로벌 및 국내 증시 핵심 현황을 분석·전달하는 주식 시장 전문 애널리스트입니다.
아래 제공된 [Yahoo Finance 실시간 실제 마감 수치]를 100% 그대로 활용하여 1번 섹션을 완성하고, Google Search로 확인된 최신 증시 뉴스를 분석하여 브리핑을 작성하세요.

[Yahoo Finance 실시간 실제 수치 (수치 절대 임의 변경 금지)]:
- 다우존스: ${marketData.dow.price} (${marketData.dow.change})
- S&P 500: ${marketData.sp500.price} (${marketData.sp500.change})
- 나스닥: ${marketData.nasdaq.price} (${marketData.nasdaq.change})
- 러셀 2000: ${marketData.russell.price} (${marketData.russell.change})
- 필라델피아 반도체: ${marketData.sox.price} (${marketData.sox.change})
- MSCI 한국 지수 ETF(EWY): ${marketData.ewy.price} (${marketData.ewy.change})
- NDF 역외환율(원/달러): ${marketData.usdkrw.price}원 (${marketData.usdkrw.change})

[작성 규칙]
1. 제목: "${dateInfo.titleStock}"
2. 문체 규칙: 문장 종결은 반드시 "~함", "~임", "~있음", "~없음" 스타일로 간결하게 끝낼 것. JSON 내부 작은따옴표(') 사용.
3. weather 필드: 위 실제 3대 지수 실제 등락률 및 장 분위기 한 줄 요약.
4. highlights 필드: 당일 핵심 포인트 3개 (~함/임 종결).
5. 4대 섹션 구성 (순서 고정):
   - 섹션 1 (id: "sec_1", category: "1. 해외 증시 마감 현황", icon: "TrendingUp", items: 7개):
     위 제공된 7개 실제 수치와 등락률을 그대로 넣고, 마감 원인을 1줄 작성할 것.
     형식 예: "{지수명}: {수치} ({등락률}) - ${weekendTag}{핵심 원인 한 줄}"
     * source: "다우", "S&P500", "나스닥", "러셀 2000", "필라델피아 반도체", "한국물", "선물"
   - 섹션 2 (id: "sec_2", category: "2. 오늘의 증시 키워드", icon: "TrendingUp", items: 4개): 핵심 테마/이슈 4가지 (source: "핵심 키워드")
   - 섹션 3 (id: "sec_3", category: "3. 주요 주식 뉴스", icon: "TrendingUp", items: 4개):
     공신력 있는 주요 언론(로이터, 블룸버그, 연합뉴스, 한국경제, WSJ 등)의 팩트 뉴스 4개. "[헤드라인]: 설명" (source: 실제 언론사명)
   - 섹션 4 (id: "sec_4", category: "4. 국내 증시 투자 전략", icon: "TrendingUp", items: 4개):
     [미국 증시 마감 총평], [국내 수급 영향], [당일 공략/주목 섹터], [실전 대응 전략] (source: "시황 분석")

[출력 포맷 규칙 - 엄격 준수]
반드시 다른 설명 없이 JSON 구조의 \`\`\`json ... \`\`\` 블록으로만 응답하세요:
{
  "title": "${dateInfo.titleStock}",
  "weather": "마켓 분위기 한 줄 요약",
  "highlights": ["포인트1", "포인트2", "포인트3"],
  "sections": [
    {
      "id": "sec_1",
      "category": "1. 해외 증시 마감 현황",
      "icon": "TrendingUp",
      "items": [{ "text": "...", "source": "..." }]
    }
  ]
}
`;
}

// 9. [데일리 인사이트] 시스템 프롬프트
function getInsightSystemPrompt(dateInfo) {
  return `
당신은 치열한 일상을 살아가는 우리 청년들에게 주체적인 삶의 태도와 성장의 통찰을 전하는 데일리 콘텐츠 에디터입니다.
매일 우리 청년들이 마주하는 고민과 성장의 본질(진로 고민, 도전과 실패, 인간관계, 자존감, 실행력, 나만의 기준, 불안과 회복탄력성 등) 중 하나를 선정하여 일일 '데일리 인사이트' JSON 데이터를 작성하세요.

[작성 규칙]
1. title: "데일리 인사이트 | {핵심 통찰을 담은 직관적인 한 줄 문구}" 형식으로 작성합니다.
2. weather: 당일 핵심 통찰을 압축한 1줄 테마 문구
3. highlights: 오늘 하루 마음에 새길 3대 실천 생각 (정확히 3개 항목, 각 1문장, 정중한 어조)
4. sections: 반드시 아래 2개 시그니처 섹션으로 구성합니다.

   - 섹션 1 (id: "sec_1", category: "1. 생각의 원점 : 길을 밝히는 한 줄의 지혜", icon: "Quote", items: 1개):
     * 신뢰할 수 있는 고전, 명저, 혹은 역사적 인물의 인용구를 3~4문장으로 정제하여 text에 작성합니다.
     * source: "{인물명}, 『{도서명}』" 형식으로 명확히 표기합니다.

   - 섹션 2 (id: "sec_2", category: "2. 마인드 피벗 : 나만의 기준을 세우는 시간", icon: "Compass", items: 1개):
     * 1번 인용구의 지혜를 오늘날 우리 청년들이 겪는 현실적인 고민과 연결하여 스스로 단단한 기준을 세울 수 있도록 돕는 실천적 해설을 3문장으로 작성합니다.
     * 단어 주의: '2030', 'MZ' 등의 단어 사용 금지 ('우리 청년들', '우리' 사용)
     * 문체 규칙: 반드시 정중하고 단호한 경어체(~합니다, ~입니다)를 엄격히 유지합니다.
     * source: "마인드 피벗"으로 표기합니다.

[출력 포맷 규칙 - 엄격 준수]
반드시 다른 설명 없이 아래 JSON 구조로 응답하세요:
{
  "title": "데일리 인사이트 | 소제목",
  "weather": "핵심 통찰 1줄 요약",
  "highlights": ["실천생각1", "실천생각2", "실천생각3"],
  "sections": [
    {
      "id": "sec_1",
      "category": "1. 생각의 원점 : 길을 밝히는 한 줄의 지혜",
      "icon": "Quote",
      "items": [{ "text": "인용 본문", "source": "저자명, 『도서명』" }]
    },
    {
      "id": "sec_2",
      "category": "2. 마인드 피벗 : 나만의 기준을 세우는 시간",
      "icon": "Compass",
      "items": [{ "text": "해설 본문", "source": "마인드 피벗" }]
    }
  ]
}
`;
}

// 10. 단일 브리핑 생성 및 DB 저장 메인 함수
async function publishBriefing(categoryType, targetDateStr) {
  const dateInfo = getKSTDateInfo(targetDateStr);
  const isStock = categoryType === 'stock';
  const isInsight = categoryType === 'insight';
  const isNews = categoryType === 'news';
  const displayCategory = isStock ? '주식 모닝 브리핑' : isInsight ? '데일리 인사이트' : '간추린 뉴스';

  console.log(`\n========================================`);
  console.log(`🚀 [${dateInfo.isoDate}] ${displayCategory} 생성 및 Supabase 저장 시작`);
  console.log(`========================================`);

  try {
    let parsedData = null;

    // 💡 A. [간추린 뉴스] 청크 분할 병렬 검색 (4개씩 2묶음) + 그라운딩 검증
    if (isNews) {
      console.log(`🔍 8대 분야 개별 Google Search 병렬 검색 가동 중... (48시간 이내 검증된 기사만 채택)`);
      const chunk1 = NEWS_SECTIONS_CONFIG.slice(0, 4);
      const chunk2 = NEWS_SECTIONS_CONFIG.slice(4, 8);

      const runSection = async (cfg) => {
        const res = await generateSingleNewsSection(cfg, dateInfo);
        console.log(`  ✓ [완료] ${cfg.category} (검증 통과 ${res.items.length}건)`);
        return res;
      };

      const res1 = await Promise.all(chunk1.map(runSection));
      const res2 = await Promise.all(chunk2.map(runSection));
      const generatedSections = [...res1, ...res2];

      const totalItems = generatedSections.reduce((sum, s) => sum + s.items.length, 0);
      console.log(`📊 전체 검증 통과 기사 수: ${totalItems}건`);

      console.log(`🌤️ 전국 날씨 및 3대 핵심 하이라이트 요약 중...`);
      const metaData = await generateNewsMeta(dateInfo, generatedSections);

      parsedData = {
        title: dateInfo.titleNews,
        weather: metaData.weather,
        highlights: metaData.highlights,
        sections: generatedSections
      };
    }
    // 💡 B. [주식 모닝 브리핑] Yahoo Finance 실시간 수치 확정 + 시황 분석
    else if (isStock) {
      const marketData = await fetchMarketData(dateInfo);

      const userPrompt = `제공된 Yahoo Finance 실제 지수 수치를 바탕으로 섹션 1을 완성하고, 오늘(${dateInfo.isoDate}) 기준 밤사이 마감된 글로벌 시황과 로이터/블룸버그/연합뉴스 증시 헤드라인을 Google Search로 검색하여 [주식 모닝 브리핑] JSON 데이터를 작성하세요.`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        config: {
          systemInstruction: getStockSystemPrompt(dateInfo, marketData),
          temperature: 0.0,
          tools: [{ googleSearch: {} }]
        }
      });

      parsedData = extractJson(response.text);
    }
    // 💡 C. [데일리 인사이트] 최근 30일 발행 중복 필터링 및 자동 재시도
    else if (isInsight) {
      const { data: recentInsights } = await supabase
        .from('briefings')
        .select('title, sections')
        .eq('category_type', 'insight')
        .order('briefing_date', { ascending: false })
        .limit(30);

      let excludedSources = [];
      if (recentInsights && recentInsights.length > 0) {
        recentInsights.forEach(row => {
          const src = row.sections?.[0]?.items?.[0]?.source;
          if (src) excludedSources.push(src.trim());
        });
      }

      const MAX_RETRIES = 3;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const blacklistText = excludedSources.length > 0
          ? `\n\n[절대 금지: 최근 이미 인용된 저자/도서 목록]\n아래 목록은 최근 발행되었으므로 절대 다시 인용하지 마십시오:\n${excludedSources.map(s => `- ${s}`).join('\n')}\n반드시 위 목록에 없는 새로운 위인/철학자/문호의 명저를 선택하세요.`
          : '';

        const userPrompt = `우리 청년을 위한 깊이 있는 주제의 [데일리 인사이트] JSON을 작성하세요.${blacklistText}`;

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          config: {
            systemInstruction: getInsightSystemPrompt(dateInfo),
            temperature: 0.85,
            responseMimeType: 'application/json',
            responseSchema: briefingResponseSchema
          }
        });

        parsedData = extractJson(response.text);

        const generatedSource = parsedData.sections?.[0]?.items?.[0]?.source || '';
        const authorMatch = generatedSource.split(',')[0].trim();

        const isDuplicate = excludedSources.some(ex =>
          (authorMatch && ex.includes(authorMatch)) || ex.includes(generatedSource)
        );

        if (isDuplicate) {
          if (attempt < MAX_RETRIES) {
            console.warn(`⚠️ [중복 감지 (시도 ${attempt}/${MAX_RETRIES})]: "${generatedSource}" 재생성합니다.`);
            excludedSources.push(generatedSource);
            continue;
          } else {
            console.warn(`⚠️ [중복 감지 (최종 시도 ${attempt}/${MAX_RETRIES})]: "${generatedSource}"를 재시도 없이 그대로 발행합니다.`);
          }
        }
        break;
      }
    }

    console.log(`✅ [${displayCategory}] Gemini 생성 완료: "${parsedData.title}"`);
    if (isInsight && parsedData.sections?.[0]?.items?.[0]?.source) {
      console.log(`📚 [신규 등록] 저자/책: ${parsedData.sections[0].items[0].source}`);
    }
    console.log(`📊 생성된 섹션 수: ${parsedData.sections.length}개 / 요약: ${parsedData.highlights.length}개`);

    // Supabase DB 갱신 (UPSERT)
    await supabase
      .from('briefings')
      .delete()
      .eq('briefing_date', dateInfo.isoDate)
      .eq('category_type', categoryType);

    const { data, error: insertError } = await supabase
      .from('briefings')
      .insert([
        {
          briefing_date: dateInfo.isoDate,
          category_type: categoryType,
          title: parsedData.title,
          weather: parsedData.weather,
          highlights: parsedData.highlights,
          sections: parsedData.sections
        }
      ])
      .select();

    if (insertError) throw insertError;
    console.log(`🎉 [${dateInfo.isoDate}] ${displayCategory} Supabase 발행 성공! (Row ID: ${data[0]?.id || 'OK'})`);

  } catch (err) {
    console.error(`❌ [${displayCategory}] 발행 처리 실패:`, err);
    throw err;
  }
}

// 11. 메인 실행기
async function main() {
  const target = process.argv[2] || 'all';
  const targetDateStr = process.argv[3] || null;

  try {
    if (target === 'stock') {
      await publishBriefing('stock', targetDateStr);
    } else if (target === 'news') {
      await publishBriefing('news', targetDateStr);
    } else if (target === 'insight') {
      await publishBriefing('insight', targetDateStr);
    } else {
      await publishBriefing('news', targetDateStr);
      await publishBriefing('stock', targetDateStr);
      await publishBriefing('insight', targetDateStr);
    }
    console.log(`\n✨ [${targetDateStr || '오늘'}] 모든 브리핑 자동 발행 작업이 완료되었습니다.\n`);
  } catch (e) {
    console.error('\n💥 프로세스 실행 중단:', e.message);
    process.exit(1);
  }
}

main();