/**
 * scripts/gemini-auto-publish.js
 * 
 * 1. 간추린 뉴스: 8대 분야 청크 병렬 검색 (실시간 팩트 기사 수집)
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

// 💡 yahoo-finance2 CJS 안전 로더
// const yfModule = require('yahoo-finance2');
// const yahooFinance = yfModule.default || yfModule;

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

// 5. Yahoo 공식 REST API 기반 7대 주요 지표 실제 시세 수집 함수
async function fetchMarketData(dateInfo) {
  console.log(`📈 [Yahoo Finance] 7대 주요 지표 실제 시세 수집 중...`);

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
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;

      const price = meta?.regularMarketPrice ?? 0;
      const prevClose = meta?.chartPreviousClose ?? meta?.previousClose ?? price;
      const changePercent = prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : 0;

      const sign = changePercent > 0 ? '+' : '';
      const formattedPrice = price >= 100 
        ? price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) 
        : price.toFixed(2);
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

// 6. [간추린 뉴스] 단일 섹션 팩트 검색
async function generateSingleNewsSection(secConfig, dateInfo) {
  const prompt = `
당신은 오늘(${dateInfo.isoDate}) 보도된 사실(Fact) 기사만을 정밀하게 정리하는 전문 뉴스 에디터입니다.
Google Search를 사용하여 아래 지정된 분야의 최신 실제 기사를 검색하고, 정확히 5개의 팩트 뉴스 항목을 생성하세요.

[검색 타깃 분야]: ${secConfig.category}
[검색 키워드 힌트]: "${secConfig.searchFocus}", "${dateInfo.isoDate}"

[엄격 규칙 - 가상 뉴스 절대 금지]
1. 오늘(${dateInfo.isoDate}) 또는 어제 실제 언론사에 보도된 팩트 기사만 작성할 것. 가공의 사실 생성을 절대 금지함.
2. 스포츠 섹션의 경우 지정 선수의 당일 경기 소식이 없으면 프로야구(KBO), 프리미어리그(EPL), 국내 골프 등 오늘자 가장 뜨거운 스포츠 팩트 기사로 대체할 것.
3. 각 문장은 반드시 명사/명사형 종결(~발표, ~기록, ~추진, ~논란, ~승리, ~전망 등)로 간결하게 작성할 것 (~함, ~임 종결 금지).
4. source에는 실제 출처 언론사명("로이터", "연합뉴스", "조선일보", "블룸버그", "BBC" 등)을 기재할 것.

반드시 아래 JSON 형식으로만 응답하세요:
\`\`\`json
{
  "id": "${secConfig.id}",
  "category": "${secConfig.category}",
  "icon": "${secConfig.icon}",
  "items": [
    { "text": "팩트 뉴스 요약 문장", "source": "실제 언론사명" },
    { "text": "팩트 뉴스 요약 문장", "source": "실제 언론사명" },
    { "text": "팩트 뉴스 요약 문장", "source": "실제 언론사명" },
    { "text": "팩트 뉴스 요약 문장", "source": "실제 언론사명" },
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

  return extractJson(response.text);
}

// 7. [간추린 뉴스] 날씨 및 메타 요약
async function generateNewsMeta(dateInfo, sections) {
  const sampleHeadlines = sections
    .flatMap(s => (s?.items ? s.items.slice(0, 2).map(i => i.text) : []))
    .filter(Boolean)
    .join('\n');

  const prompt = `
오늘(${dateInfo.isoDate}) 대한민국 전국 날씨를 Google Search로 검색하고, 아래 수집된 오늘자 주요 뉴스 헤드라인을 바탕으로 [간추린 뉴스]의 날씨와 3줄 하이라이트를 작성하세요.

[오늘자 수집된 주요 뉴스 샘플]:
${sampleHeadlines}

[작성 규칙]:
1. weather: 오늘 전국 날씨/기온 한 줄 요약 (명사형 종결)
2. highlights: 오늘 아침 가장 주목할 톱 헤드라인 3개 (각 1문장, 명사형 종결)

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

    // 💡 A. [간추린 뉴스] 청크 분할 병렬 검색 (4개씩 2묶음)
    if (isNews) {
      console.log(`🔍 8대 분야 개별 Google Search 병렬 검색 가동 중...`);
      const chunk1 = NEWS_SECTIONS_CONFIG.slice(0, 4);
      const chunk2 = NEWS_SECTIONS_CONFIG.slice(4, 8);

      const runSection = async (cfg) => {
        const res = await generateSingleNewsSection(cfg, dateInfo);
        console.log(`  ✓ [완료] ${cfg.category} (${res.items.length}개 팩트 확보)`);
        return res;
      };

      const res1 = await Promise.all(chunk1.map(runSection));
      const res2 = await Promise.all(chunk2.map(runSection));
      const generatedSections = [...res1, ...res2];

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

        if (isDuplicate && attempt < MAX_RETRIES) {
          console.warn(`⚠️ [중복 감지 (시도 ${attempt}/${MAX_RETRIES})]: "${generatedSource}" 재생성합니다.`);
          excludedSources.push(generatedSource);
          continue;
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