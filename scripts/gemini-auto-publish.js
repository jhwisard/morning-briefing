/**
 * scripts/gemini-auto-publish.js
 * Gemini 2.5 Flash를 이용한 '간추린 뉴스' 및 '주식 모닝 브리핑' 자동 발행 스크립트
 * 
 * 실행 방법:
 *   node scripts/gemini-auto-publish.js stock   # 주식 모닝 브리핑만 발행
 *   node scripts/gemini-auto-publish.js news    # 간추린 뉴스만 발행
 *   node scripts/gemini-auto-publish.js all     # 둘 다 순차 발행 (기본값)
 */

const { GoogleGenAI, Type } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');
 
// 1. 환경 변수 확인
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ 필수 환경 변수가 누락되었습니다 (GEMINI_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { createClient: false }
});


// 2. KST (한국 표준시) 기준 날짜 계산
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
    headerNews: `'${shortYear}-${parseInt(mm)}/${parseInt(dd)}(${weekday})`
  };
}

// 3. 공통 JSON 응답 스키마
const briefingResponseSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: '브리핑 표준 제목' },
    weather: { type: Type.STRING, description: '마켓 한 줄 요약 또는 전국 날씨 요약' },
    highlights: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '출근길 1분 핵심 3줄 요약'
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

// 4. [주식 모닝 브리핑] 시스템 프롬프트
function getStockSystemPrompt(dateInfo) {
  return `
당신은 매일 개장 전 글로벌 및 국내 증시 핵심 현황을 분석·전달하는 주식 시장 전문 애널리스트입니다.
아래의 [작성 규칙]을 철저히 준수하여 당일 아침 기준 '주식 모닝 브리핑' JSON 데이터를 생성하세요.

[작성 규칙]
1. 제목: "${dateInfo.titleStock}"
2. 문체 및 종결어미 규칙 (엄격 준수):
   - 본문 전체의 문장 종결은 반드시 "~함", "~임", "~있음", "~없음" 스타일로 간결하고 명확하게 끝낼 것.
3. weather 필드:
   - 3대 지수 등락률 및 장 분위기를 한 줄로 작성 (예: "다우 -0.22% · S&P500 -0.69% · 나스닥 -1.33% (유가 급등 및 금리 상승에 따른 기술주 조정)")
4. highlights 필드:
   - 당일 시장을 관통하는 3대 핵심 포인트를 구체적 수치와 함께 작성 (정확히 3개 항목, ~함/임 종결)
5. 4대 섹션 구성 (sections):
   - 섹션 1 (id: "sec_1", category: "1. 해외 증시 마감 현황", icon: "TrendingUp"):
     다우 지수, S&P 500, 나스닥, 러셀 2000, 필라델피아 반도체 지수, MSCI 한국 지수 ETF, 야간 선물 등 7대 지수 마감 수치와 등락률(%), 간략 요약 작성 (각각 source: "다우", "S&P500", "나스닥", "소형주", "반도체", "한국물", "선물")
   - 섹션 2 (id: "sec_2", category: "2. 오늘의 증시 키워드", icon: "TrendingUp"):
     당일 글로벌/국내 시장을 관통하는 핵심 테마 및 이슈 4가지 (text 앞에 "1. ", "2. ", "3. ", "4. " 표기, source: "핵심 키워드")
   - 섹션 3 (id: "sec_3", category: "3. 주요 주식 뉴스", icon: "TrendingUp"):
     시장 영향력이 큰 핵심 뉴스 4개. text는 "헤드라인: 상세 요약 설명" 형식으로 작성하고, source에는 실제 언론사 명시 (예: 로이터, 블룸버그, 연합뉴스 등)
   - 섹션 4 (id: "sec_4", category: "4. 오늘의 시황 요약", icon: "TrendingUp"):
     미국 증시 마감 분석, 국내 증시 수급 영향(외국인/기관 동향), 당일 공략 섹터 및 실전 대응 전략 등 3~4개 항목 작성. 콜론(:) 설명이 필요할 경우 "헤드라인 요약: 상세 설명" 형식으로 한 줄 작성 (source: "시황 분석")
6. 팩트 기반 원칙:
   - 지수 수치, 등락률, 종목명, 구체적인 경제 지표 결과를 정확한 사실에 기반하여 기술할 것.
`;
}

// 5. [간추린 뉴스] 시스템 프롬프트
function getNewsSystemPrompt(dateInfo) {
  return `
당신은 매일 아침 글로벌 및 국내 주요 뉴스를 정밀하게 큐레이션하는 전문 뉴스 브리퍼입니다.
아래의 [작성 규칙]을 철저히 준수하여 당일 아침 기준 '간추린 뉴스' JSON 데이터를 생성하세요.

[작성 규칙]
1. 제목: "${dateInfo.titleNews}"
2. 기사 선정 우선순위:
   - 각 섹션의 항목은 주요 포털 및 언론사에서 가장 많이 다룬 '랭킹 뉴스(많이 본 뉴스)', '헤드라인 탑뉴스', '실시간 주요 속보'를 최우선 순위로 선별할 것.
3. 문장 및 종결어미 서식 (엄격 준수):
   - 문장 끝 종결어미는 "~함", "~임", "~있음" 등의 서술어를 절대 사용하지 말고, 반드시 명사/명사형 종결(~발표, ~지속, ~기록, ~맞대응, ~추진, ~논란, ~우승, ~달성, ~강화, ~전환, ~전망 등)로 간결하게 끝낼 것.
4. weather 필드:
   - 당일 전국 종합 날씨 및 폭염/소나기/기온 요약 작성 (예: "전국 대부분 폭염특보 속 체감 33~35도 안팎 무더위 및 열대야 지속, 내륙 중심 소나기")
5. highlights 필드:
   - 오늘 아침 가장 주목할 톱 헤드라인 3개 문장 (명사형 종결)
6. 8대 뉴스 섹션 구성 (순서 변경 불가, 각 섹션마다 정확히 5개 항목 작성):
   - 섹션 1 (id: "sec_1", category: "[美미국]", icon: "Globe", items: 5개)
   - 섹션 2 (id: "sec_2", category: "[中중국,대만]", icon: "Globe", items: 5개)
   - 섹션 3 (id: "sec_3", category: "[러시아,우크라이나,이스라엘,이란,북한]", icon: "Globe", items: 5개)
   - 섹션 4 (id: "sec_4", category: "[英영국,佛프랑스,獨독일]", icon: "Globe", items: 5개)
   - 섹션 5 (id: "sec_5", category: "[日일본]", icon: "Globe", items: 5개)
   - 섹션 6 (id: "sec_6", category: "[한국.정치.사회]", icon: "Globe", items: 5개)
   - 섹션 7 (id: "sec_7", category: "[한국.경제]", icon: "TrendingUp", items: 5개)
   - 섹션 8 (id: "sec_8", category: "[스포츠:이정후.안세영.KLPGA.LPBA]", icon: "Sparkles", items: 5개):
     * 필수 포함 5개 구성:
       1) 이정후 (MLB 경기 기록/활약/이슈)
       2) 안세영 (배드민턴 경기 기록/국제 대회/협회 관련 이슈)
       3) KLPGA (금주 투어 대회 순위/주요 선수 소식)
       4) LPBA (한국프로당구협회 대회 소식/주요 선수 소식/타이틀 경쟁)
       5) 위 4개 분야 중 당일 가장 화제가 된 랭킹 1위 이슈 1건 추가 배정
7. 항목(item) 작성 형식:
   - text: 구체적인 수치, 인명, 고유명사를 포함한 명사형 종결 문장
   - source: 실제 출처 언론사 명시 (예: "연합뉴스", "로이터", "조선비즈", "골프다이제스트" 등)
`;
}

// 6. 단일 카테고리 발행 실행 함수
async function publishBriefing(categoryType) {
  const dateInfo = getKSTDateInfo();
  const isStock = categoryType === 'stock';
  const displayCategory = isStock ? '주식 모닝 브리핑' : '간추린 뉴스';

  console.log(`\n========================================`);
  console.log(`🚀 [${dateInfo.isoDate}] ${displayCategory} 자동 생성 및 발행 시작`);
  console.log(`========================================`);

  const systemPrompt = isStock 
    ? getStockSystemPrompt(dateInfo) 
    : getNewsSystemPrompt(dateInfo);

  const userPrompt = isStock
    ? `${dateInfo.headerStock} 기준 최신 글로벌 증시 마감 지표 및 주요 뉴스를 반영하여 [주식 모닝 브리핑] JSON 데이터를 생성해 주세요.`
    : `${dateInfo.headerNews} 기준 밤사이 발생한 국내외 톱 랭킹 뉴스와 스포츠/날씨를 반영하여 [간추린 뉴스] JSON 데이터를 생성해 주세요.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseSchema: briefingResponseSchema,
        temperature: 0.2
      }
    });

    const parsedData = JSON.parse(response.text);
    console.log(`✅ [${displayCategory}] Gemini 생성 완료: "${parsedData.title}"`);
    console.log(`📊 생성된 섹션 수: ${parsedData.sections.length}개`);

    // Supabase 당일 동일 카테고리 삭제 후 신규 저장 (UPSERT)
    const { error: delError } = await supabase
      .from('briefings')
      .delete()
      .eq('briefing_date', dateInfo.isoDate)
      .eq('category_type', categoryType);

    if (delError) {
      console.warn(`⚠️ 기존 데이터 정리 알림:`, delError.message);
    }

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
    console.error(`❌ [${displayCategory}] 발행 실패:`, err);
    throw err;
  }
}

// 7. 메인 실행기
async function main() {
  const target = process.argv[2] || 'all';

  try {
    if (target === 'stock') {
      await publishBriefing('stock');
    } else if (target === 'news') {
      await publishBriefing('news');
    } else {
      // all: 뉴스 -> 주식 순차 발행
      await publishBriefing('news');
      await publishBriefing('stock');
    }
    console.log('\n✨ 모든 브리핑 자동 발행 파이프라인이 성공적으로 종료되었습니다.\n');
  } catch (e) {
    console.error('\n💥 프로세스 실행 중단:', e.message);
    process.exit(1);
  }
}

main();
