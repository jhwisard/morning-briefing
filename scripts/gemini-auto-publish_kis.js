/**
 * scripts/gemini-auto-publish.js
 *
 * 1. 간추린 뉴스: "실제 존재가 확인된 기사"만 후보로 모은 뒤 Gemini는 그 중에서 고르고 요약만 함
 * 2. 주식 모닝 브리핑: sec_1~sec_9 9섹션 구조.
 *    - sec_1 오늘의 키워드 / sec_2 해외증시 / sec_3 주요뉴스 / sec_4 이슈딥다이브 : Gemini + Google 검색 + Yahoo Finance
 *    - sec_5 코스피·코스닥 수급 / sec_6 업종별 / sec_7 외국인·기관 매수상위 : KIS API(fetch-korea-market.js)
 *    - sec_8 원자재 포지션 : Yahoo Finance 선물 티커
 *    - sec_9 오늘의 투자 인사이트 : Gemini
 *    KIS 데이터가 없으면(설정 전/실패 시) sec_5~7은 "데이터 연동 준비 중"으로만 표시되고
 *    Gemini가 수치를 지어내지 않도록 프롬프트에서 원천 차단됨.
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
const RssParser = require('rss-parser'); // npm install rss-parser 필요
// 💡 KIS API로 코스피/코스닥 수급, 업종별, 외국인·기관 매수상위 데이터를 가져오는 모듈 (sec_5~7)
const { fetchKoreaMarketData } = require('./fetch-korea-market'); // npm install 불필요, 순수 fetch 사용

// 💡 뉴스 후보 확보용 선택적 API 키 (없으면 해당 소스는 건너뛰고 RSS만 사용)
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID?.trim();
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET?.trim();
const SERPAPI_KEY = process.env.SERPAPI_KEY?.trim();

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

// 💡 8대 뉴스 섹션별 전용 검색 쿼리 설정 (기존과 동일, 변경 없음)
const NEWS_SECTIONS_CONFIG = [
  {
    id: 'sec_1', category: '[美미국]', icon: 'Globe',
    searchFocus: '미국 정치 경제 외교 주요 뉴스', naverQuery: '미국 정치 경제 외교',
    feeds: [
      { name: 'BBC', url: 'http://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml' },
      { name: 'NYT', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
      { name: '가디언', url: 'https://www.theguardian.com/us-news/rss' },
      { name: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml' }
    ]
  },
  {
    id: 'sec_2', category: '[中중국,대만]', icon: 'Globe',
    searchFocus: '중국 대만 양안관계 뉴스', naverQuery: '중국 대만 양안관계',
    feeds: [
      { name: 'BBC', url: 'http://feeds.bbci.co.uk/news/world/asia/rss.xml' },
      { name: '타이베이타임스', url: 'https://www.taipeitimes.com/xml/index.rss' }
    ]
  },
  {
    id: 'sec_3', category: '[러시아,우크라이나,이스라엘,이란,북한]', icon: 'Globe',
    searchFocus: '러시아 우크라이나 이스라엘 이란 북한 안보 뉴스', naverQuery: '러시아 우크라이나 이스라엘 이란 북한',
    feeds: [
      { name: 'BBC', url: 'http://feeds.bbci.co.uk/news/world/rss.xml' },
      { name: '알자지라', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
      { name: '타임스오브이스라엘', url: 'https://www.timesofisrael.com/feed/' }
    ]
  },
  {
    id: 'sec_4', category: '[英영국,佛프랑스,獨독일]', icon: 'Globe',
    searchFocus: '영국 프랑스 독일 유럽연합 뉴스', naverQuery: '영국 프랑스 독일 유럽연합',
    feeds: [
      { name: 'BBC', url: 'http://feeds.bbci.co.uk/news/uk/rss.xml' },
      { name: '가디언', url: 'https://www.theguardian.com/world/europe-news/rss' },
      { name: 'DW', url: 'https://rss.dw.com/rdf/rss-en-all' }
    ]
  },
  {
    id: 'sec_5', category: '[日일본]', icon: 'Globe',
    searchFocus: '일본 정치 경제 사회 뉴스', naverQuery: '일본 정치 경제 사회',
    feeds: [
      { name: '재팬타임스', url: 'https://www.japantimes.co.jp/feed/' },
      { name: 'BBC', url: 'http://feeds.bbci.co.uk/news/world/asia/rss.xml' }
    ]
  },
  {
    id: 'sec_6', category: '[한국.정치.사회]', icon: 'Globe',
    searchFocus: '한국 정치 사회 주요 뉴스', naverQuery: '한국 정치 사회 정부 국회',
    feeds: [
      { name: '연합뉴스', url: 'https://www.yna.co.kr/rss/politics.xml' },
      { name: '연합뉴스', url: 'https://www.yna.co.kr/rss/society.xml' }
    ]
  },
  {
    id: 'sec_7', category: '[한국.경제]', icon: 'TrendingUp',
    searchFocus: '한국 경제 금융 증시 뉴스', naverQuery: '한국 경제 금융 증시 부동산',
    feeds: [
      { name: '연합뉴스', url: 'https://www.yna.co.kr/rss/economy.xml' }
    ]
  },
  {
    id: 'sec_8', category: '[스포츠:이정후.안세영.KLPGA.PBA]', icon: 'Sparkles',
    promptCategory: '국내외 주요 스포츠 뉴스 전반 (야구·배드민턴·골프·당구 등 특정 종목에 국한하지 않음, 이정후/안세영/KLPGA/PBA 소식이 있으면 우선)',
    searchFocus: '한국 스포츠 야구 골프 배드민턴 뉴스', naverQuery: '프로야구 KBO 스포츠',
    feeds: [
      { name: '연합뉴스', url: 'https://www.yna.co.kr/rss/sports.xml' }
    ]
  }
];

// 💡 신뢰 언론사 화이트리스트 (기존과 동일, 변경 없음)
const TRUSTED_DOMAINS = {
  '연합뉴스': ['yna.co.kr'], '연합뉴스TV': ['yonhapnewstv.co.kr'], '뉴시스': ['newsis.com'],
  '뉴스1': ['news1.kr'], '조선일보': ['chosun.com'], '중앙일보': ['joongang.co.kr', 'joins.com'],
  '동아일보': ['donga.com'], '한국일보': ['hankookilbo.com'], '경향신문': ['khan.co.kr'],
  '한겨레': ['hani.co.kr'], '서울신문': ['seoul.co.kr'], '국민일보': ['kmib.co.kr'],
  '문화일보': ['munhwa.com'], '세계일보': ['segye.com'], '내일신문': ['naeil.com'],
  'KBS': ['news.kbs.co.kr', 'kbs.co.kr'], 'MBC': ['imnews.imbc.com', 'imbc.com'],
  'SBS': ['news.sbs.co.kr'], 'JTBC': ['news.jtbc.co.kr'], 'TV조선': ['tvchosun.com'],
  '채널A': ['ichannela.com', 'news.ichannela.com'], 'MBN': ['mbn.co.kr'], 'YTN': ['ytn.co.kr'],
  '노컷뉴스': ['nocutnews.co.kr'], '프레시안': ['pressian.com'], '오마이뉴스': ['ohmynews.com'],
  '데일리안': ['dailian.co.kr'], '뉴데일리': ['newdaily.co.kr'], '아이뉴스24': ['inews24.com'],
  '메트로신문': ['metroseoul.co.kr'], '공정뉴스': ['fairnews.co.kr'], '아주경제': ['ajunews.com'],
  'SBS Biz': ['biz.sbs.co.kr'], '한국금융신문': ['fntimes.com'], '코리아중앙데일리': ['koreajoongangdaily.joins.com'],
  '더구루': ['theguru.co.kr'], '매일경제': ['mk.co.kr'], '한국경제': ['hankyung.com', 'wowtv.co.kr'],
  '헤럴드경제': ['heraldcorp.com'], '이데일리': ['edaily.co.kr'], '머니투데이': ['mt.co.kr'],
  '아시아경제': ['asiae.co.kr'], '파이낸셜뉴스': ['fnnews.com'], '뉴스핌': ['newspim.com'],
  '이투데이': ['etoday.co.kr'], '전자신문': ['etnews.com'], 'ZDNet Korea': ['zdnet.co.kr'],
  '디지털타임스': ['dt.co.kr'], '블로터': ['bloter.net'], '디일렉': ['thelec.kr'],
  'AI타임스': ['aitimes.com'], '글로벌이코노믹': ['g-enews.com'], '조세일보': ['joseilbo.com'],
  '연합인포맥스': ['yonhapinfomax.co.kr'], '자본시장뉴스': ['capitalmarket.co.kr'], '알파경제': ['alphabiz.co.kr'],
  '경기일보': ['kyeonggi.com'], '강원일보': ['kwnews.co.kr'], '부산일보': ['busan.com'],
  '매일신문': ['imaeil.com'], '영남일보': ['yeongnam.com'], '광주일보': ['kwangju.co.kr'],
  '충청투데이': ['cctoday.co.kr'], '대전일보': ['daejonilbo.com'], '이코노미스트(한국)': ['economist.co.kr'],
  '한국금융경제신문': ['kfenews.com'], '스포츠서울': ['sportsseoul.com'], '스타뉴스': ['starnewskorea.com'],
  '엑스포츠뉴스': ['xportsnews.com'], '일간스포츠': ['isplus.com'], 'OSEN': ['osen.co.kr'],
  '스포츠조선': ['sportschosun.com'], '마이데일리': ['mydaily.co.kr'], '로이터': ['reuters.com'],
  '블룸버그': ['bloomberg.com'], 'AP': ['apnews.com'], 'AFP': ['afp.com'], 'CNN': ['cnn.com'],
  'NYT': ['nytimes.com'], '뉴욕타임스': ['nytimes.com'], 'WSJ': ['wsj.com'], '월스트리트저널': ['wsj.com'],
  '워싱턴포스트': ['washingtonpost.com'], 'NPR': ['npr.org'], 'ABC뉴스': ['abcnews.go.com'],
  'NBC뉴스': ['nbcnews.com'], 'CBS뉴스': ['cbsnews.com'], '폭스뉴스': ['foxnews.com'],
  '폴리티코': ['politico.com'], '액시오스': ['axios.com'], 'USA투데이': ['usatoday.com'],
  'LA타임스': ['latimes.com'], '타임': ['time.com'], '뉴스위크': ['newsweek.com'], '포브스': ['forbes.com'],
  '비즈니스인사이더': ['businessinsider.com'], 'CNBC': ['cnbc.com'], '마켓워치': ['marketwatch.com'],
  '야후뉴스': ['news.yahoo.com', 'finance.yahoo.com'], '테크크런치': ['techcrunch.com'],
  '더버지': ['theverge.com'], '와이어드': ['wired.com'], 'BBC': ['bbc.com', 'bbc.co.uk'],
  '가디언': ['theguardian.com'], '파이낸셜타임스': ['ft.com'], '이코노미스트': ['economist.com'],
  '스카이뉴스': ['news.sky.com'], 'ITV뉴스': ['itv.com'], '도이체벨레': ['dw.com'], '슈피겔': ['spiegel.de'],
  '르몽드': ['lemonde.fr'], '타스': ['tass.com'], '리아노보스티': ['ria.ru'], '인테르팍스': ['interfax.com', 'interfax.ru'],
  '니혼게이자이': ['nikkei.com'], '아사히신문': ['asahi.com'], '요미우리신문': ['yomiuri.co.jp'],
  '마이니치신문': ['mainichi.jp'], '교도통신': ['kyodonews.net'], 'NHK': ['nhk.or.jp'],
  '재팬타임스': ['japantimes.co.jp'], '퍼시픽 리그.com': ['pacificleague.com'], '신화통신': ['xinhuanet.com', 'news.cn'],
  '인민일보': ['people.com.cn'], '글로벌타임스': ['globaltimes.cn'], 'CCTV': ['cctv.com'], 'SCMP': ['scmp.com'],
  '타이베이타임스': ['taipeitimes.com'], '중앙통신사(대만)': ['focustaiwan.tw'], '알자지라': ['aljazeera.com'],
  '타임스오브이스라엘': ['timesofisrael.com'], '하레츠': ['haaretz.com']
};

// 3. 한국 표준시(KST) 날짜 계산 (기존과 동일)
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
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short'
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

// 4. Supabase 연동용 JSON 스키마 (인사이트용, 기존과 동일)
const briefingResponseSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: '브리핑 표준 제목' },
    weather: { type: Type.STRING, description: '마켓 요약 또는 날씨/테마 한 줄 요약' },
    highlights: { type: Type.ARRAY, items: { type: Type.STRING }, description: '핵심 3줄 요약' },
    sections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING }, category: { type: Type.STRING }, icon: { type: Type.STRING },
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { text: { type: Type.STRING }, source: { type: Type.STRING } },
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

const DOMAIN_TO_OUTLET = {};
for (const [name, domains] of Object.entries(TRUSTED_DOMAINS)) {
  domains.forEach(d => { DOMAIN_TO_OUTLET[d] = name; });
}
function outletNameForDomain(domain) {
  if (!domain) return null;
  if (DOMAIN_TO_OUTLET[domain]) return DOMAIN_TO_OUTLET[domain];
  const matchKey = Object.keys(DOMAIN_TO_OUTLET).find(d => domain.endsWith(`.${d}`));
  return matchKey ? DOMAIN_TO_OUTLET[matchKey] : null;
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function stripHtmlEntities(s) {
  return (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim();
}

const RSS_PARSER = new RssParser({
  timeout: 8000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
});

function truncateSnippet(s, max = 220) {
  const clean = stripHtmlEntities(s || '');
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

async function fetchRssCandidates(feed) {
  try {
    const parsed = await RSS_PARSER.parseURL(feed.url);
    return (parsed.items || []).map(item => {
      const pubMs = item.isoDate ? Date.parse(item.isoDate) : (item.pubDate ? Date.parse(item.pubDate) : NaN);
      return {
        source: feed.name,
        title: (item.title || '').trim(),
        snippet: truncateSnippet(item.contentSnippet || item.summary || item.content || ''),
        link: item.link,
        pubDate: item.isoDate || item.pubDate || null,
        pubMs
      };
    });
  } catch (err) {
    console.warn(`  ⚠️ [RSS 실패] ${feed.name} (${feed.url}) - ${err.message}`);
    return [];
  }
}

async function fetchNaverNewsCandidates(query) {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET || !query) return [];
  try {
    const url = `https://naverapihub.apigw.ntruss.com/search/v1/news?query=${encodeURIComponent(query)}&display=20&sort=date`;
    const res = await fetch(url, {
      headers: { 'X-NCP-APIGW-API-KEY-ID': NAVER_CLIENT_ID, 'X-NCP-APIGW-API-KEY': NAVER_CLIENT_SECRET }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json.items || []).map(it => {
      const link = it.originallink || it.link;
      const domain = getDomain(link);
      const pubMs = it.pubDate ? Date.parse(it.pubDate) : NaN;
      return {
        source: outletNameForDomain(domain) || domain || '네이버뉴스',
        title: stripHtmlEntities(it.title),
        snippet: truncateSnippet(it.description || ''),
        link, pubDate: it.pubDate || null, pubMs
      };
    });
  } catch (err) {
    console.warn(`  ⚠️ [네이버 뉴스 API 실패] "${query}" - ${err.message}`);
    return [];
  }
}

async function fetchSerpApiCandidates(query) {
  if (!SERPAPI_KEY || !query) return [];
  try {
    const url = `https://serpapi.com/search.json?engine=google_news&q=${encodeURIComponent(query)}&hl=ko&gl=kr&api_key=${SERPAPI_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json.news_results || []).map(it => {
      const link = it.link;
      const domain = getDomain(link);
      const pubMs = it.date ? Date.parse(it.date) : NaN;
      return {
        source: it.source?.name || outletNameForDomain(domain) || domain || 'SerpAPI',
        title: it.title, snippet: truncateSnippet(it.snippet || ''),
        link, pubDate: it.date || null, pubMs
      };
    });
  } catch (err) {
    console.warn(`  ⚠️ [SerpAPI 실패] "${query}" - ${err.message}`);
    return [];
  }
}

function normalizeForDedupe(title) {
  return (title || '').replace(/\s+/g, '').slice(0, 30);
}

function dedupeCandidates(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (!c || !c.title || !c.link) continue;
    const key = `${getDomain(c.link) || ''}|${normalizeForDedupe(c.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

async function fetchCategoryCandidates(secConfig, cutoffMs) {
  const rssResults = await Promise.all((secConfig.feeds || []).map(fetchRssCandidates));
  const naverResults = await fetchNaverNewsCandidates(secConfig.naverQuery);
  const serpResults = await fetchSerpApiCandidates(secConfig.searchFocus);

  const all = [...rssResults.flat(), ...naverResults, ...serpResults];
  const withinWindow = all.filter(c => Number.isFinite(c.pubMs) && c.pubMs >= cutoffMs);
  const dropped = all.length - withinWindow.length;
  if (dropped > 0) {
    console.log(`  · [${secConfig.category}] 게재시각 미확인/48시간 초과로 후보 ${dropped}건 제외 (전체 수집 ${all.length}건)`);
  }

  const deduped = dedupeCandidates(withinWindow);
  deduped.sort((a, b) => b.pubMs - a.pubMs);
  return deduped.slice(0, 40);
}

// 5. Yahoo Finance 실제 종가 및 등락률 정밀 계산 함수
// 💡 sec_2(해외증시) + sec_8(원자재 포지션)용으로 티커 10개로 확장
async function fetchMarketData(dateInfo) {
  console.log(`📈 [Yahoo Finance] 10대 주요 지표 실제 시세 및 등락률 수집 중...`);

  const tickers = {
    dow: '^DJI', sp500: '^GSPC', nasdaq: '^IXIC', russell: '^RUT', sox: '^SOX',
    ewy: 'EWY', usdkrw: 'KRW=X',
    // 💡 sec_8 원자재 포지션용 추가 티커
    gold: 'GC=F', wti: 'CL=F', copper: 'HG=F'
  };

  const results = {};

  for (const [key, symbol] of Object.entries(tickers)) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
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

      const changePercent = (prevClose && prevClose !== 0) ? ((currentPrice - prevClose) / prevClose) * 100 : 0;
      const sign = changePercent > 0 ? '+' : '';
      const formattedPrice = currentPrice >= 100
        ? currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : currentPrice.toFixed(2);
      const formattedChange = `${sign}${changePercent.toFixed(2)}%`;

      results[key] = { symbol, price: formattedPrice, change: formattedChange };
    } catch (err) {
      console.warn(`  ⚠️ [Yahoo Finance] ${symbol} 조회 실패 (${err.message})`);
      results[key] = { symbol, price: '조회중', change: '0.00%' };
    }
  }

  console.log(`  ✓ 다우: ${results.dow.price} (${results.dow.change}) | 반도체: ${results.sox.price} (${results.sox.change})`);
  console.log(`  ✓ 금: ${results.gold.price} (${results.gold.change}) | WTI: ${results.wti.price} (${results.wti.change}) | 구리: ${results.copper.price} (${results.copper.change})`);

  return results;
}

// 6. [간추린 뉴스] 단일 섹션 (기존과 동일, 변경 없음)
const newsPickSchema = {
  type: Type.OBJECT,
  properties: {
    picks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          index: { type: Type.INTEGER, description: '후보 목록에서 선택한 기사의 번호' },
          text: { type: Type.STRING, description: '해당 기사의 한국어 한 문장 요약 (명사형 종결)' }
        },
        required: ['index', 'text']
      }
    }
  },
  required: ['picks']
};

async function generateSingleNewsSection(secConfig, dateInfo) {
  const cutoffMs = Date.now() - 48 * 60 * 60 * 1000;
  const candidates = await fetchCategoryCandidates(secConfig, cutoffMs);

  if (candidates.length === 0) {
    console.warn(`  ⚠️ [${secConfig.category}] 48시간 이내 후보 기사가 0건입니다. 빈 섹션으로 발행됩니다.`);
    return { id: secConfig.id, category: secConfig.category, icon: secConfig.icon, items: [] };
  }

  const candidateListText = candidates
    .map((c, i) => {
      const snippetPart = c.snippet ? ` — ${c.snippet}` : '';
      return `${i}. [${c.source}] ${c.title}${snippetPart} (${c.pubDate || '시각 미상'})`;
    })
    .join('\n');

  const prompt = `
당신은 아래 "실제로 수집된 후보 기사 목록"에서만 골라 뉴스를 정리하는 에디터입니다.
이 목록은 RSS/뉴스 API로 이미 실제 존재가 확인된 기사들이며, 목록에 없는 사실을 추가하거나 지어내는 것은 절대 금지합니다.

[분야]: ${secConfig.promptCategory || secConfig.category}
[오늘 날짜(KST)]: ${dateInfo.isoDate}

[후보 기사 목록] (번호. [언론사] 제목 — 스니펫 (게재시각))
${candidateListText}

[작업 지시]
1. 위 목록 중 "${secConfig.promptCategory || secConfig.category}" 분야에서 가장 중요하고 대표성 있는 기사를 최대 5개 선택하십시오.
2. 각 기사를 한국어 한 문장으로 요약하되, 제목과 스니펫에 담긴 구체적 사실을 반영해 정보량 있게 작성. 명사형 종결로 간결하게.
3. 목록이 전달하는 사실 범위를 벗어나는 내용을 절대 덧붙이지 마십시오.
4. source나 url은 적지 마십시오 — index만 알려주면 됩니다.

반드시 아래 JSON 형식으로만 응답하세요:
{ "picks": [ { "index": 0, "text": "요약 문장" } ] }`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { temperature: 0.0, responseMimeType: 'application/json', responseSchema: newsPickSchema }
  });

  const parsed = extractJson(response.text);
  const picks = Array.isArray(parsed.picks) ? parsed.picks : [];

  const seen = new Set();
  const items = [];
  const invalidPicks = [];
  for (const p of picks) {
    const idx = p?.index;
    if (typeof idx !== 'number' || !candidates[idx] || seen.has(idx)) {
      invalidPicks.push(p);
      continue;
    }
    seen.add(idx);
    items.push({ text: (p.text || candidates[idx].title || '').trim(), source: candidates[idx].source });
    if (items.length >= 5) break;
  }

  if (invalidPicks.length > 0) {
    console.warn(`  ⚠️ [${secConfig.category}] 존재하지 않는 index를 반환한 pick ${invalidPicks.length}건 무시`);
  }
  console.log(`  ✓ [완료] ${secConfig.category} (후보 ${candidates.length}건 중 ${items.length}건 채택)`);

  return { id: secConfig.id, category: secConfig.category, icon: secConfig.icon, items };
}

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
{ "weather": "날씨 한 줄 요약", "highlights": ["핵심 헤드라인 1", "핵심 헤드라인 2", "핵심 헤드라인 3"] }
\`\`\``;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { temperature: 0.0, tools: [{ googleSearch: {} }] }
  });

  return extractJson(response.text);
}

// 8. [주식 모닝 브리핑] 시스템 프롬프트 — sec_1~sec_9 9섹션 구조
function getStockSystemPrompt(dateInfo, marketData, koreaData) {
  const isWeekend = dateInfo.isWeekendClosed;
  const weekendTag = isWeekend ? '[직전 거래일 마감] ' : '';

  // 💡 KIS 데이터가 없으면(미설정/실패) sec_5~7 관련 프롬프트 블록을 "데이터 없음"으로 명시해서
  // Gemini가 없는 수치를 지어내지 못하게 원천 차단
  const hasKoreaData = koreaData && (koreaData.kospiFlow || koreaData.sectors?.length || koreaData.foreignTop?.length);

  const koreaDataBlock = hasKoreaData ? `
[국내 수급/업종 실제 데이터 (KIS API, 수치 절대 임의 변경 금지)]
- 코스피 수급: 개인 ${koreaData.kospiFlow?.individual ?? '데이터없음'} / 외국인 ${koreaData.kospiFlow?.foreign ?? '데이터없음'} / 기관 ${koreaData.kospiFlow?.institution ?? '데이터없음'}
- 코스닥 수급: 개인 ${koreaData.kosdaqFlow?.individual ?? '데이터없음'} / 외국인 ${koreaData.kosdaqFlow?.foreign ?? '데이터없음'} / 기관 ${koreaData.kosdaqFlow?.institution ?? '데이터없음'}
- 업종별 상위 등락 (코스피): ${(koreaData.sectors || []).slice(0, 8).map(s => `${s.sectorName} ${s.changeRate}%`).join(', ') || '데이터없음'}
- 업종별 상위 등락 (코스닥): ${(koreaData.kosdaqSectors || []).slice(0, 8).map(s => `${s.sectorName} ${s.changeRate}%`).join(', ') || '데이터없음'}
- 외국인/기관 순매수 상위 종목: ${(koreaData.foreignTop || []).slice(0, 10).map(s => s.name).join(', ') || '데이터없음'}
` : `
[국내 수급/업종 데이터 없음]
KIS API 데이터가 없으므로 sec_5, sec_6, sec_7의 items는 반드시 빈 배열([])로 두거나
"데이터 연동 준비 중입니다."라는 문장 하나만 넣으십시오. 절대 수치를 지어내지 마십시오.
`;

  return `
당신은 매일 개장 전 글로벌 및 국내 증시 핵심 현황을 분석·전달하는 주식 시장 전문 애널리스트입니다.
아래 제공된 실제 수치 데이터를 100% 그대로 활용하고, Google Search로 확인된 최신 증시 뉴스를 분석하여 브리핑을 작성하세요.

[Yahoo Finance 실시간 실제 수치 (수치 절대 임의 변경 금지)]:
- 다우존스: ${marketData.dow.price} (${marketData.dow.change})
- S&P 500: ${marketData.sp500.price} (${marketData.sp500.change})
- 나스닥: ${marketData.nasdaq.price} (${marketData.nasdaq.change})
- 러셀 2000: ${marketData.russell.price} (${marketData.russell.change})
- 필라델피아 반도체: ${marketData.sox.price} (${marketData.sox.change})
- MSCI 한국 지수 ETF(EWY): ${marketData.ewy.price} (${marketData.ewy.change})
- NDF 역외환율(원/달러): ${marketData.usdkrw.price}원 (${marketData.usdkrw.change})
- 금(GC=F): ${marketData.gold.price} (${marketData.gold.change})
- WTI 원유(CL=F): ${marketData.wti.price} (${marketData.wti.change})
- 구리(HG=F): ${marketData.copper.price} (${marketData.copper.change})
${koreaDataBlock}

[작성 규칙]
1. 제목: "${dateInfo.titleStock}"
2. 문체 규칙: 문장 종결은 반드시 "~함", "~임", "~있음", "~없음" 스타일로 간결하게 끝낼 것. JSON 내부 작은따옴표(') 사용.
3. weather 필드: 3대 지수 실제 등락률 및 장 분위기 한 줄 요약.
4. highlights 필드: 당일 핵심 포인트 3개 (~함/임 종결).
5. 9개 섹션 구성 (순서·id 고정):

   - sec_1 "1. 오늘의 증시 키워드" (icon: "Sparkles", items 4개):
     당일 핵심 테마/이슈 4가지. source: "핵심 키워드"

   - sec_2 "2. 해외 증시 마감 현황" (icon: "TrendingUp", items 7개):
     다우/S&P500/나스닥/러셀2000/반도체지수/MSCI한국/환율 7개 실제 수치와 등락률, 마감 원인 1줄.
     형식: "{지표명}: {수치} ({등락률}) - ${weekendTag}{핵심 원인 한줄}"
     source: 각 지표명("다우","S&P500","나스닥","러셀 2000","필라델피아 반도체","MSCI한국","환율")

   - sec_3 "3. 주요 뉴스" (icon: "Newspaper", items 4개):
     로이터/블룸버그/연합뉴스/한국경제 등 공신력 있는 매체의 팩트 뉴스.
     "[헤드라인]: 설명" 형식. source: 실제 언론사명

   - sec_4 "4. 오늘의 이슈 딥다이브" (icon: "Globe", items 1~2개):
     오늘 시장에 가장 큰 영향을 준 단일 이슈(물가지표, 빅테크 실적, 연준 발언 등) 하나를 골라
     배경-수치-시장반응을 3~4문장으로 깊이 있게 설명. source: "이슈 분석"

   - sec_5 "5. 코스피·코스닥 수급 동향" (icon: "TrendingUp", items 최대 2개):
     [국내 수급/업종 실제 데이터]의 코스피/코스닥 수급 수치를 그대로 인용해 서술.
     데이터 없으면 규칙대로 빈 배열 또는 안내문. source: "수급 동향"

   - sec_6 "6. 업종별 동향" (icon: "TrendingUp", items 최대 6개):
     코스피/코스닥 업종별 상위 등락을 그대로 인용. 데이터 없으면 규칙대로 처리.
     source: "업종 분석"

   - sec_7 "7. 외국인·기관 매수 상위" (icon: "Users", items 최대 5개):
     외국인/기관 순매수 상위 종목명을 그대로 나열하고 배경 뉴스가 있으면 1줄 덧붙임.
     데이터 없으면 규칙대로 처리. source: "수급 상위"

   - sec_8 "8. 원자재 포지션" (icon: "TrendingUp", items 3개):
     금/WTI/구리 수치를 그대로 인용하고 최근 추세를 1줄씩. source: "금","WTI","구리"

   - sec_9 "9. 오늘의 투자 인사이트" (icon: "Lightbulb", items 1개):
     오늘 시황과 연결되는 투자자 행동/원칙 관련 짧은 교훈. 구체적 수치나 사례를 곁들여 3문장 이내.
     source: "투자 인사이트"

[출력 포맷 규칙 - 엄격 준수]
반드시 다른 설명 없이 JSON 구조의 \`\`\`json ... \`\`\` 블록으로만 응답하세요:
{
  "title": "${dateInfo.titleStock}",
  "weather": "마켓 분위기 한 줄 요약",
  "highlights": ["포인트1", "포인트2", "포인트3"],
  "sections": [
    { "id": "sec_1", "category": "1. 오늘의 증시 키워드", "icon": "Sparkles", "items": [{ "text": "...", "source": "..." }] }
  ]
}
`;
}

// 9. [데일리 인사이트] 시스템 프롬프트 (기존과 동일, 변경 없음)
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
    { "id": "sec_1", "category": "1. 생각의 원점 : 길을 밝히는 한 줄의 지혜", "icon": "Quote", "items": [{ "text": "인용 본문", "source": "저자명, 『도서명』" }] },
    { "id": "sec_2", "category": "2. 마인드 피벗 : 나만의 기준을 세우는 시간", "icon": "Compass", "items": [{ "text": "해설 본문", "source": "마인드 피벗" }] }
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

    // A. [간추린 뉴스] (기존과 동일, 변경 없음)
    if (isNews) {
      console.log(`🔍 8대 분야 RSS/네이버API/SerpAPI 후보 수집 및 선별 가동 중...`);
      const chunk1 = NEWS_SECTIONS_CONFIG.slice(0, 4);
      const chunk2 = NEWS_SECTIONS_CONFIG.slice(4, 8);

      const res1 = await Promise.all(chunk1.map(cfg => generateSingleNewsSection(cfg, dateInfo)));
      const res2 = await Promise.all(chunk2.map(cfg => generateSingleNewsSection(cfg, dateInfo)));
      const generatedSections = [...res1, ...res2];

      const totalItems = generatedSections.reduce((sum, s) => sum + s.items.length, 0);
      console.log(`📊 전체 채택 기사 수: ${totalItems}건`);

      console.log(`🌤️ 전국 날씨 및 3대 핵심 하이라이트 요약 중...`);
      const metaData = await generateNewsMeta(dateInfo, generatedSections);

      parsedData = {
        title: dateInfo.titleNews,
        weather: metaData.weather,
        highlights: metaData.highlights,
        sections: generatedSections
      };
    }
    // B. [주식 모닝 브리핑] — Yahoo Finance + KIS API(sec_5~7) + Gemini
    else if (isStock) {
      const marketData = await fetchMarketData(dateInfo);

      // 💡 KIS 미설정/실패해도 에러로 전체가 죽지 않고 null 반환 → 프롬프트가 해당 섹션만 생략 처리
      let koreaData = null;
      try {
        koreaData = await fetchKoreaMarketData();
      } catch (err) {
        console.warn('  ⚠️ [KIS API] 국내 데이터 수집 실패 — sec_5~7은 생략됩니다:', err.message);
      }

      const userPrompt = `제공된 실제 수치들을 바탕으로 각 섹션을 완성하고, 오늘(${dateInfo.isoDate}) 기준 밤사이 마감된 글로벌 시황과 국내 증시 관련 헤드라인을 Google Search로 검색하여 [주식 모닝 브리핑] JSON 데이터를 작성하세요.`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        config: {
          systemInstruction: getStockSystemPrompt(dateInfo, marketData, koreaData),
          temperature: 0.0,
          tools: [{ googleSearch: {} }]
        }
      });

      parsedData = extractJson(response.text);
    }
    // C. [데일리 인사이트] (기존과 동일, 변경 없음)
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
      .insert([{
        briefing_date: dateInfo.isoDate,
        category_type: categoryType,
        title: parsedData.title,
        weather: parsedData.weather,
        highlights: parsedData.highlights,
        sections: parsedData.sections
      }])
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
    process.exit(0);
  } catch (e) {
    console.error('\n💥 프로세스 실행 중단:', e.message);
    process.exit(1);
  }
}

main();