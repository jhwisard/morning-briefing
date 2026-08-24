/**
 * scripts/gemini-auto-publish.js
 * Gemini 2.5 Flash + Google Search Grounding 기반 실시간 '간추린 뉴스' & '주식 모닝 브리핑' & '데일리 인사이트' 일일 자동 발행 스크립트
 * 
 * 실행 옵션:
 *   node scripts/gemini-auto-publish.js stock    # 주식 모닝 브리핑만 발행
 *   node scripts/gemini-auto-publish.js news     # 간추린 뉴스만 발행
 *   node scripts/gemini-auto-publish.js insight  # 데일리 인사이트만 발행
 *   node scripts/gemini-auto-publish.js all      # 3대 콘텐츠 전체 순차 발행 (기본값)
 */

// Next.js 내장 환경 변수 로더 (.env.local 자동 로드)
const { loadEnvConfig } = require('@next/env');
loadEnvConfig(process.cwd());

const { GoogleGenAI, Type } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

// 1. 환경 변수 가져오기 (공백 및 따옴표 제거)
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

// 3. 한국 표준시(KST) 기준 날짜 계산
function getKSTDateInfo() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short'
  });

  const parts = formatter.formatToParts(now);
  const map = {};
  parts.forEach(p => (map[p.type] = p.value));

  const yyyy = map.year;
  const mm = String(map.month).padStart(2, '0');
  const dd = String(map.day).padStart(2, '0');
  const weekday = map.weekday;
  const shortYear = yyyy.slice(-2);

  return {
    isoDate: `${yyyy}-${mm}-${dd}`,
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

// 5. [간추린 뉴스] 시스템 프롬프트
function getNewsSystemPrompt(dateInfo) {
  return `
당신은 오늘(${dateInfo.isoDate}) 아침 실제 보도된 국내외 핵심 뉴스를 정밀하게 큐레이션하는 전문 팩트 기반 뉴스 브리퍼입니다.
반드시 구글 검색(Google Search)을 통해 확인된 실제 오늘자 최신 뉴스만 작성해야 합니다.

[작성 원칙 - 엄격 준수]
1. 제목: "${dateInfo.titleNews}"
2. 실시간 팩트 검증 및 검색 최적화:
   - 오늘(${dateInfo.isoDate}) 기준 최근 24~48시간 이내에 실제 보도된 글로벌/국내 기사를 기반으로 작성할 것.
   - 과거(2023년~2024년 등 과거) 지나간 기사, 가상의 사실, 또는 임의의 명칭(예: 'OOO 챔피언십')을 절대 생성하지 말 것.
   - 해외 섹션(유럽, 미국 등)은 국내 번역 기사뿐만 아니라 현지 주요 외신(로이터, 블룸버그, BBC, AFP, Le Monde, DW 등)의 최신 팩트를 적극 검색하여 반영할 것.
   - 당일 자정 이후 속보가 부족한 경우, 전일(어제) 오후~저녁에 보도된 중요 헤드라인을 반드시 포함하여 각 섹션 5개를 빈틈없이 채울 것.
   - "뉴스는 확인되지 않음"과 같은 안내 문구 출력을 절대 금지하며, 경제 지표, 외교 성명, 정책 발표 등 최신 공식 뉴스를 선별해 채울 것.
3. 문장 및 종결어미 서식:
   - 문장 끝 종결어미는 "~함", "~임", "~있음" 등의 서술어를 절대 사용하지 말고, 반드시 명사/명사형 종결(~발표, ~지속, ~기록, ~맞대응, ~추진, ~논란, ~우승, ~달성, ~강화, ~전환, ~전망 등)로 간결하게 끝낼 것.
4. weather 필드:
   - [날씨] 항목: 오늘 전국 대부분 지역 날씨/기온/특보를 명사형 한 줄 요약 작성
5. highlights 필드:
   - 오늘 아침 가장 주목할 톱 헤드라인 3개 문장 (명사형 종결)
6. 8대 섹션 구성 (각 섹션 정확히 5개 항목 구성):
    [해외 섹션 1~5 공통 3:2 구성 룰]
   * 각 섹션의 5개 항목은 '현지/글로벌 외신 팩트 뉴스 3개' + '해당 국가/지역 관련 국내 언론 보도 2개'로 균형 있게 구성할 것.
   * 외신 검색 시 로이터(Reuters), 블룸버그(Bloomberg), AP, AFP, BBC, 현지 언론 등을 적극 활용할 것.

   - 섹션 1 (id: "sec_1", category: "[美미국]", icon: "Globe", items: 5개)
     * 미국 현지 주요 정치/경제/글로벌 외신 3개 + 미국 발 국내 영향 및 언론 보도 2개
   - 섹션 2 (id: "sec_2", category: "[中중국,대만]", icon: "Globe", items: 5개)
     * 중국/대만 현지 정책/외교/경제 외신 3개 + 양안 관계 및 국내 영향 언론 보도 2개
   - 섹션 3 (id: "sec_3", category: "[러시아,우크라이나,이스라엘,이란,북한]", icon: "Globe", items: 5개)
     * 분쟁 지역/국제 안보 관련 외신 3개 + 한국 외교/안보 대응 및 국내 보도 2개
   - 섹션 4 (id: "sec_4", category: "[英영국,佛프랑스,獨독일]", icon: "Globe", items: 5개)
     * 유럽 현지 외신(영국/프랑스/독일/EU 주요 이슈) 3개 + 유럽 발 국내 산업/경제/외교 보도 2개 (영문 검색 'UK', 'France', 'Germany', 'EU' 활용)
   - 섹션 5 (id: "sec_5", category: "[日일본]", icon: "Globe", items: 5개)
     * 일본 현지 경제/정치/사회 외신 3개 + 한일 관계 및 국내 보도 2개

   - 섹션 6 (id: "sec_6", category: "[한국.정치.사회]", icon: "Globe", items: 5개)
     * 국내 주요 정치, 정책, 사회 톱 헤드라인 5개
   - 섹션 7 (id: "sec_7", category: "[한국.경제]", icon: "TrendingUp", items: 5개)
     * 국내 금융, 부동산, 산업, 기업 실적 등 경제 핵심 뉴스 5개
   - 섹션 8 (id: "sec_8", category: "[스포츠:이정후.안세영.KLPGA.PBA]", icon: "Sparkles", items: 5개)
     * 스포츠 섹션 작성 규칙 (5개 항목 엄격 완성):
       - '미확인', '확인되지 않음', '소식 없음', '일정 없음' 등의 부정적/안내성 단어 출력을 엄격히 금지함.
       - 아래 우선순위 순서대로 탐색하되, 비시즌이거나 당일 경기/투어 소식이 없을 경우 즉시 다음 대체 팩트 뉴스로 채워 5개를 완성할 것:
         1) 이정후 / 메이저리그 (MLB 공식 활약, 기록, 인터뷰, 재활/복귀 소식)
         2) 안세영 / 한국 배드민턴 (대회 결과, 협회 소식, 훈련 근황)
         3) KLPGA 골프 (투어 경기 결과, 순위, 선수 소식 / 대회 없을 시 LPGA, KPGA, PGA 최신 골프 뉴스로 대체)
         4) PBA / 프로당구 (최근 투어 소식, 랭킹, 김가영/스롱 피아비 등 스타 선수 소식 / 대회 없을 시 KBO 프로야구, 프로축구 K리그, 해외파 축구 소식으로 즉시 대체)
         5) 대한민국 스포츠 톱 핫이슈 (손흥민, 김민재, 이강인, 오타니, KBO 구단 순위 등 오늘자 가장 뜨거운 스포츠 헤드라인)
7. 항목(item) 작성 규칙:
   - text: 구체적인 수치, 인명, 고유명사, 실제 대회명, 점수, 기관명을 반드시 포함한 명사형 종결 문장.
   - source: 실제 출처 언론사명만 기재 (외신: "로이터", "블룸버그", "AP", "BBC", "CNN" 등 / 국내: "연합뉴스", "한국경제", "KBS", "SBS", "스포츠조선" 등)

[출력 포맷 규칙 - 엄격 준수]
반드시 다른 설명 없이 아래 JSON 구조의 \`\`\`json ... \`\`\` 블록으로만 응답하세요:
{
  "title": "${dateInfo.titleNews}",
  "weather": "날씨 한 줄 요약",
  "highlights": ["요약1", "요약2", "요약3"],
  "sections": [
    {
      "id": "sec_1",
      "category": "[美미국]",
      "icon": "Globe",
      "items": [{ "text": "내용", "source": "출처" }]
    }
  ]
}
`;
}
// 6. 8대 섹션 구성 (각 섹션 정확히 5개 항목 구성):
//    - 섹션 1 (id: "sec_1", category: "[美미국]", icon: "Globe", items: 5개)
//    - 섹션 2 (id: "sec_2", category: "[中중국,대만]", icon: "Globe", items: 5개)
//    - 섹션 3 (id: "sec_3", category: "[러시아,우크라이나,이스라엘,이란,북한]", icon: "Globe", items: 5개)
//    - 섹션 4 (id: "sec_4", category: "[英영국,佛프랑스,獨독일]", icon: "Globe", items: 5개)
//    - 섹션 5 (id: "sec_5", category: "[日일본]", icon: "Globe", items: 5개)
//    - 섹션 6 (id: "sec_6", category: "[한국.정치.사회]", icon: "Globe", items: 5개)
//    - 섹션 7 (id: "sec_7", category: "[한국.경제]", icon: "TrendingUp", items: 5개)
//    - 섹션 8 (id: "sec_8", category: "[스포츠:이정후.안세영.KLPGA.PBA]", icon: "Sparkles", items: 5개)
//    * 스포츠 섹션 작성 규칙 (5개 항목 엄격 완성):
//      - '미확인', '확인되지 않음', '소식 없음', '일정 없음' 등의 부정적/안내성 단어 출력을 엄격히 금지함.
//      - 아래 우선순위 순서대로 탐색하되, 비시즌이거나 당일 경기/투어 소식이 없을 경우 즉시 다음 대체 팩트 뉴스로 채워 5개를 완성할 것:
//        1) 이정후 / 메이저리그 (MLB 공식 활약, 기록, 인터뷰, 재활/복귀 소식)
//        2) 안세영 / 한국 배드민턴 (대회 결과, 협회 소식, 훈련 근황)
//        3) KLPGA 골프 (투어 경기 결과, 순위, 선수 소식 / 대회 없을 시 LPGA, KPGA, PGA 최신 골프 뉴스로 대체)
//        4) PBA / 프로당구 (최근 투어 소식, 랭킹, 김가영/스롱 피아비 등 스타 선수 소식 / 대회 없을 시 KBO 프로야구, 프로축구 K리그, 해외파 축구 소식으로 즉시 대체)
//        5) 대한민국 스포츠 톱 핫이슈 (손흥민, 김민재, 이강인, 오타니, KBO 구단 순위 등 오늘자 가장 뜨거운 스포츠 헤드라인)

// 6. [주식 모닝 브리핑] 시스템 프롬프트
function getStockSystemPrompt(dateInfo) {
  return `
당신은 매일 개장 전 글로벌 및 국내 증시 핵심 현황을 분석·전달하는 주식 시장 전문 애널리스트입니다.
구글 검색을 통해 ${dateInfo.isoDate} 기준 밤사이 실제 마감된 글로벌 지수 수치와 경제 지표를 정확히 검색하여 작성하세요.

[작성 규칙]
1. 제목: "${dateInfo.titleStock}"
2. 문체 및 종결어미 규칙:
   - 본문 전체의 문장 종결은 반드시 "~함", "~임", "~있음", "~없음" 스타일로 간결하고 명확하게 끝낼 것.
3. weather 필드:
   - 밤사이 실제 마감된 다우, S&P500, 나스닥 3대 지수 실제 등락률 및 장 분위기를 한 줄로 요약.
4. highlights 필드:
   - 당일 시장을 관통하는 3대 핵심 포인트를 구체적 수치와 함께 작성 (정확히 3개 항목, ~함/임 종결)
5. 전체 4대 섹션 구성 및 순서 (순서 변경 불가):
   - 섹션 1 (id: "sec_1", category: "1. 해외 증시 마감 현황", icon: "TrendingUp"):
     다우 지수(Dow), S&P 500, 나스닥(Nasdaq), 러셀 2000(소형주), 필라델피아 반도체(SOX), MSCI 한국 지수 ETF(EWY), 코스피200 야간선물(또는 NDF 환율) 등 7개 지표의 실제 최근 마감 수치와 등락률(%), 원인을 정확히 검색하여 1줄로 작성.
     * 야간선물 검색 팁: '코스피200 야간선물 종가' 또는 '야간선물 마감'으로 검색하되, 정확한 포인트 수치가 검색되지 않을 경우 'NDF 역외환율' 마감 수치나 코스피 야간선물 등락률(%)을 기재할 것.
     * text 형식 규칙: "{지수명}: {실제마감수치} ({등락률}%) - {원인 및 마감 동향 요약}"
     * 절대 임의의 숫자를 지어내지 말고 검색된 실제 종가를 작성할 것.
     * source: "다우", "S&P500", "나스닥", "러셀 2000", "필라델피아 반도체", "한국물", "선물"로 지정. 

   - 섹션 2 (id: "sec_2", category: "2. 오늘의 증시 키워드", icon: "TrendingUp", items: 4개):
     밤사이 미국 증시 마감 결과를 관통하는 핵심 테마 및 이슈 4가지 선별 (예: 빅테크 실적, 금리/국채금리, 유가/원자재, 정책 이슈 등) (~함/임 종결, source: "핵심 키워드")

   - 섹션 3 (id: "sec_3", category: "3. 주요 주식 뉴스", icon: "TrendingUp", items: 4개):
     글로벌 및 국내 증시에 파급력이 큰 핵심 뉴스 4개.
     * text 형식: "[헤드라인]: 시장 및 특정 산업 영향 요약 설명" (~함/임 종결)
     * source: 실제 출처 언론사 명시 (예: "로이터", "블룸버그", "연합뉴스", "한국경제" 등)

   - 섹션 4 (id: "sec_4", category: "4. 국내 증시 투자 전략", icon: "TrendingUp", items: 4개):
     앞선 섹션 1~3의 글로벌 시황과 뉴스를 종합 분석하여 작성하는 국내 증시 실전 가이드 (총 4개 항목):
     1) [미국 증시 마감 총평]: 뉴욕 증시 흐름이 국내 시장에 미치는 전반적 분위기
     2) [국내 수급 영향]: 외국인·기관의 예상 수급 방향 및 원/달러 환율 영향
     3) [당일 공략/주목 섹터]: 글로벌 흐름에 맞춰 오늘 국내 시장에서 부각될 유망 업종/테마
     4) [실전 대응 전략]: 개장 전 개인 투자자가 취해야 할 구체적인 매매/비중 조절 원칙
     * text 형식: "[소제목]: [상세 분석/전략 내용]" (~함/임/있음/없음 종결, source: "시황 분석")
6. 팩트 기반 원칙:
   - 지수 수치, 등락률, 종목명, 경제 지표 결과를 실제 사실에 기반하여 기술할 것.

[출력 포맷 규칙 - 엄격 준수]
반드시 다른 설명 없이 아래 JSON 구조의 \`\`\`json ... \`\`\` 블록으로만 응답하세요:
{
  "title": "${dateInfo.titleStock}",
  "weather": "마켓 분위기 한 줄 요약",
  "highlights": ["포인트1", "포인트2", "포인트3"],
  "sections": [
    {
      "id": "sec_1",
      "category": "1. 해외 증시 마감 현황",
      "icon": "TrendingUp",
      "items": [{ "text": "내용", "source": "출처" }]
    }
  ]
}
`;
}

// - 섹션 1 (id: "sec_1", category: "1. 해외 증시 마감 현황", icon: "TrendingUp"):
//  다우 지수, S&P 500, 나스닥, 러셀 2000, 필라델피아 반도체 지수, MSCI 한국 지수 ETF, 야간 선물 등 7대 지수 마감 수치와 등락률(%), 원인 및 마감 동향을 1줄로 명시.
//  * text 형식 예시:
//    - "다우: 39,250.12 (+0.15%) - 에너지 및 방산주 강세로 소폭 상승 마감함."
//    - "S&P500: 5,280.45 (-0.45%) - 기술주 약세에도 불구하고 일부 섹터의 선방으로 낙폭이 제한됨."
//    - "나스닥: 17,020.30 (-1.20%) - 고금리 환경 지속 우려에 성장주 중심의 매도세가 출현함."
//    - "소형주: 2,050.10 (-0.80%) - 경기 둔화 우려와 금리 부담에 하락세를 보임."
//    - "반도체: 4,850.25 (-2.10%) - 대형 기술주 부진에 따라 지수 전반이 크게 하락함."
//    - "한국물: 72.80 (-1.55%) - 미국 증시 하락과 원화 약세 영향으로 동반 하락함."
//    - "선물: 345.50 (-0.70%) - 미국 증시 하락분을 반영하며 국내 증시 개장 전 약세 흐름을 보임."
//  * source는 각각 "다우", "S&P500", "나스닥", "소형주", "반도체", "한국물", "선물"로 지정.
//    - 섹션 2 (id: "sec_2", category: "2. 오늘의 증시 키워드", icon: "TrendingUp"):
//      당일 글로벌/국내 시장을 관통하는 핵심 테마 및 이슈 4가지 (~함/임 종결, source: "핵심 키워드")
//    - 섹션 3 (id: "sec_3", category: "3. 주요 주식 뉴스", icon: "TrendingUp"):
//      시장 영향력이 큰 핵심 뉴스 4개. text 형식은 "[헤드라인]: 시장 영향 요약 설명" 형태로 작성하고, source에는 실제 출처 언론사 명시 (예: "로이터", "연합뉴스", "블룸버그" 등)
//    - 섹션 4 (id: "sec_4", category: "4. 오늘의 시황 요약", icon: "TrendingUp"):
//      미국 증시 마감 분석, 국내 증시 수급 영향(외국인/기관 동향), 당일 공략 섹터 및 실전 대응 전략을 3~4개 항목으로 정리. text는 "[요약 헤드라인]: [상세 전략/분석]" 또는 단일 완성 문장으로 작성 (~함/임/있음/없음 종결, source: "시황 분석")


// 7. [데일리 인사이트] 2단 시그니처 템플릿 시스템 프롬프트
function getInsightSystemPrompt(dateInfo) {
  return `
당신은 20대 청년들에게 주체적인 삶의 태도와 성장의 통찰을 전하는 데일리 콘텐츠 에디터입니다.
매일 20대의 고민과 성장을 관통하는 핵심 주제(진로 고민, 도전과 실패, 인간관계, 자존감, 실행력, 나만의 기준, 불안과 회복탄력성, 시간 관리 등) 중 하나를 선정하여 아래의 시그니처 포맷에 맞춰 일일 '데일리 인사이트' JSON 데이터를 작성하세요.

[작성 규칙]
1. title: "데일리 인사이트 | {핵심 통찰을 담은 직관적인 한 줄 문구}" 형식으로 작성합니다.
2. weather: 당일 핵심 통찰을 압축한 1줄 테마 문구
3. highlights: 오늘 하루 마음에 새길 3대 실천 생각 (정확히 3개 항목, 각 1문장, 정중한 어조)
4. sections: 반드시 아래 2개 시그니처 섹션으로 구성합니다.

   - 섹션 1 (id: "sec_1", category: "1. 생각의 원점 : 길을 밝히는 한 줄의 지혜", icon: "Quote", items: 1개):
     * 신뢰할 수 있는 고전, 명저, 혹은 역사적 인물의 인용구를 3~4문장으로 정제하여 text에 작성합니다.
     * source: 인용한 저자명과 도서명을 명확히 표기합니다. (형식 예: "프리드리히 니체, 『차라투스트라는 이렇게 말했다』", "에픽테토스, 『담화록』", "빅터 프랭클, 『죽음의 수용소에서』")

   - 섹션 2 (id: "sec_2", category: "2. 마인드 피벗 : 나만의 기준을 세우는 시간", icon: "Compass", items: 1개):
     * 20-30대의 고민과 트렌드 관점에서 깊이 공감하고 스스로 기준을 세울 수 있도록 돕는 실천적 해설을 3~4문장으로 작성합니다.
     * 문체 규칙: 반드시 정중하고 단호한 경어체(~합니다, ~입니다)를 엄격히 유지합니다.
     * source: "마인드 피벗"으로 표기합니다.
`;
}

// 💡 안전한 JSON 추출 헬퍼 함수
function extractJson(rawText) {
  if (!rawText) throw new Error('AI 응답이 비어있습니다.');
  
  // 1. ```json ... ``` 마크다운 블록 추출
  const match = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const jsonStr = match ? match[1].trim() : rawText.trim();
  
  // 2. JSON 파싱 시도
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    // 3. 실패 시 첫 번째 '{' 와 마지막 '}' 사이만 추출해서 파싱
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      return JSON.parse(jsonStr.substring(firstBrace, lastBrace + 1));
    }
    throw e;
  }
}

// 8. 단일 브리핑 생성 및 DB 저장 함수
async function publishBriefing(categoryType) {
  const dateInfo = getKSTDateInfo();
  const isStock = categoryType === 'stock';
  const isInsight = categoryType === 'insight';
  const displayCategory = isStock ? '주식 모닝 브리핑' : isInsight ? '데일리 인사이트' : '간추린 뉴스';

  console.log(`\n========================================`);
  console.log(`🚀 [${dateInfo.isoDate}] ${displayCategory} 생성 및 Supabase 저장 시작`);
  console.log(`========================================`);

  const systemPrompt = isStock 
    ? getStockSystemPrompt(dateInfo) 
    : isInsight
    ? getInsightSystemPrompt(dateInfo)
    : getNewsSystemPrompt(dateInfo);

    const userPrompt = isStock
    const userPrompt = isStock
    ? `Google Search를 활용하여 ${dateInfo.isoDate} 기준 최근 마감된 미국 뉴욕증시(다우, S&P500, 나스닥, 반도체 등) 동향 및 금융 뉴스를 검색하고, 시스템 프롬프트 규격에 맞는 단일 JSON 블록으로만 [주식 모닝 브리핑]을 작성하세요. 다른 인사말이나 설명 문장은 일절 포함하지 마세요.`
    // ? `Google Search를 활용하여 ${dateInfo.isoDate} 기준 가장 최근 마감된 미국 뉴욕증시 3대 지수(다우, S&P500, 나스닥) 및 필라델피아 반도체, 러셀2000, EWY의 '실제 종가와 등락률'을 정확히 확인한 후 [주식 모닝 브리핑] JSON 데이터를 생성하세요. 임의의 수치 생성을 절대 금지합니다.`
    : isInsight
    ? `20-30대 청년을 위한 깊이 있는 주제를 바탕으로 [생각의 원점] 고전/명저 인용(3~4문장)과 [마인드 피벗] 정중한 경어체(~합니다) 실천 해설(3~4문장)을 담은 [데일리 인사이트] JSON 데이터를 생성하세요.`
    : `Google Search를 활용하여 ${dateInfo.isoDate} 기준 최근 24~48시간 이내의 국내외 8대 분야(미국, 중국/대만, 러·우·중동·북한, 유럽, 일본, 한국 정치사회, 한국 경제, 스포츠) 최신 팩트 뉴스를 검색하세요. 유럽 뉴스는 현지 외신(UK, France, Germany) 팩트를 적극 반영하고, 스포츠는 대상 선수 경기/근황 및 국내 핫이슈로 각 섹션당 정확히 5개 항목을 채워 단일 JSON 블록으로만 응답하세요.`;
  try {
    let config = {
      systemInstruction: systemPrompt,
      temperature: isInsight ? 0.7 : 0.1
    };

    // 💡 핵심: googleSearch 툴 사용 시에는 responseMimeType 설정을 제거하고, 인사이트만 Schema 사용
    if (isInsight) {
      config.responseMimeType = 'application/json';
      config.responseSchema = briefingResponseSchema;
    } else {
      config.tools = [{ googleSearch: {} }];
    }

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      config: config
    });

    // 💡 안전한 JSON 파싱 (마크다운 코드 블록 대응)
    const parsedData = extractJson(response.text);

    console.log(`✅ [${displayCategory}] Gemini 생성 완료: "${parsedData.title}"`);
    console.log(`📊 생성된 섹션 수: ${parsedData.sections.length}개 / 요약: ${parsedData.highlights.length}개`);

    // 기존 당일 동일 카테고리 데이터 삭제 후 신규 등록 (UPSERT)
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

// 9. 메인 실행기
async function main() {
  const target = process.argv[2] || 'all';

  try {
    if (target === 'stock') {
      await publishBriefing('stock');
    } else if (target === 'news') {
      await publishBriefing('news');
    } else if (target === 'insight') {
      await publishBriefing('insight');
    } else {
      // all: 간추린 뉴스 -> 주식 모닝 브리핑 -> 데일리 인사이트 순차 발행
      await publishBriefing('news');
      await publishBriefing('stock');
      await publishBriefing('insight');
    }
    console.log('\n✨ 모든 브리핑 자동 발행 작업이 성공적으로 완료되었습니다.\n');
  } catch (e) {
    console.error('\n💥 프로세스 실행 중단:', e.message);
    process.exit(1);
  }
}

main();
