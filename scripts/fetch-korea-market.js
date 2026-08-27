/**
 * scripts/fetch-korea-market.js
 *
 * 한국투자증권(KIS) Open API로 국내 수급/업종/외국인·기관 매수 데이터를 가져오는 모듈.
 * gemini-auto-publish.js의 fetchMarketData()와 나란히 호출해서 stock 섹션을 확장하는 용도.
 *
 * ⚠️ 필요한 사전 작업 (직접 확인 후 채워야 하는 값 3가지):
 *   1) https://apiportal.koreainvestment.com 에서 앱 등록 → APP_KEY / APP_SECRET 발급
 *   2) 아래 KIS_ENDPOINTS의 tr_id 값들을 포탈의 각 API 문서 페이지에서 정확한 값으로 교체
 *      (예: "외국인 매매종목가집계" 문서 페이지 상단에 tr_id가 명시돼 있음)
 *   3) 응답 필드명(output.xxx)도 포탈 문서의 Response 스펙과 대조해서 맞춰야 함
 *      (여기 적어둔 필드명은 KIS API의 일반적인 네이밍 컨벤션을 따른 추정치이며,
 *       실제 응답을 한 번 콘솔에 찍어보고 확정할 것을 강력히 권장)
 *
 * 필요한 환경변수: KIS_APP_KEY, KIS_APP_SECRET
 */

const KIS_BASE_URL = 'https://openapi.koreainvestment.com:9443';

const KIS_APP_KEY = process.env.KIS_APP_KEY?.trim();
const KIS_APP_SECRET = process.env.KIS_APP_SECRET?.trim();

let cachedToken = null;
let cachedTokenExpiry = 0;
// 💡 동시에 여러 함수(외국인매수/업종별/수급 등)가 한꺼번에 토큰을 요청해도
// 실제 발급 요청은 딱 1번만 나가도록 "진행 중인 발급 요청"을 공유하는 락(lock) 역할
let tokenFetchPromise = null;

// ── 1. OAuth 접근토큰 발급 ────────────────────────────────────────────
// ⚠️ KIS는 짧은 시간 내 동일 appkey로 반복 토큰 발급 시도 시 403으로 차단하는 정책이 있어서,
// Promise.all()로 여러 함수를 동시에 호출해도 토큰 요청은 절대 중복 발사되지 않도록 직렬화함.
async function getKisAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  if (!KIS_APP_KEY || !KIS_APP_SECRET) {
    console.warn('  ⚠️ [KIS API] KIS_APP_KEY/KIS_APP_SECRET 미설정 — 국내 수급/업종 데이터는 건너뜁니다.');
    return null;
  }

  // 이미 발급이 진행 중이면 새 요청을 또 보내지 않고 그 결과를 기다렸다가 재사용
  if (tokenFetchPromise) return tokenFetchPromise;

  tokenFetchPromise = (async () => {
    try {
      const res = await fetch(`${KIS_BASE_URL}/oauth2/tokenP`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          appkey: KIS_APP_KEY,
          appsecret: KIS_APP_SECRET
        })
      });

      if (!res.ok) {
        // 💡 실패 원인을 정확히 보려면 응답 본문(에러코드/설명)까지 같이 찍어야 함
        const errBody = await res.text().catch(() => '(본문 읽기 실패)');
        throw new Error(`KIS 토큰 발급 실패: HTTP ${res.status} - ${errBody}`);
      }

      const json = await res.json();
      cachedToken = json.access_token;
      cachedTokenExpiry = Date.now() + 12 * 60 * 60 * 1000;
      return cachedToken;
    } finally {
      // 성공하든 실패하든 락은 풀어서 다음 호출(예: 다음 날 크론)이 다시 시도할 수 있게 함
      tokenFetchPromise = null;
    }
  })();

  return tokenFetchPromise;
}

// ── 2. 공통 GET 래퍼 ──────────────────────────────────────────────────
// path/trId/params는 포탈 문서에서 그대로 복사해서 채우면 됨
async function callKisGet(path, trId, params) {
  const token = await getKisAccessToken();
  if (!token) return null;

  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${KIS_BASE_URL}${path}?${qs}`, {
    headers: {
      'Content-Type': 'application/json',
      'authorization': `Bearer ${token}`,
      'appkey': KIS_APP_KEY,
      'appsecret': KIS_APP_SECRET,
      'tr_id': trId,
      'custtype': 'P' // 개인
    }
  });

  if (!res.ok) {
    console.warn(`  ⚠️ [KIS API] ${path} 호출 실패: HTTP ${res.status}`);
    return null;
  }
  return res.json();
}

// ── 3. 외국인/기관 순매수 상위종목 ───────────────────────────────────
// 문서: "외국인 매매종목가집계[국내주식-037]"
// TODO: tr_id를 포탈 문서에서 확인한 정확한 값으로 교체 (아래는 플레이스홀더)
async function fetchForeignInstitutionTopBuys() {
  const json = await callKisGet(
    '/uapi/domestic-stock/v1/quotations/foreign-institution-total',
    'FHPTJ04400000', // TODO: 포탈 문서 값으로 검증/교체
    {
      FID_COND_MRKT_DIV_CODE: 'V', // V=전체, KOSPI+KOSDAQ 통합 등 옵션은 문서 참조
      FID_COND_SCR_DIV_CODE: '16449',
      FID_INPUT_ISCD: '0000',
      FID_DIV_CLS_CODE: '0', // 0: 매수상위
      FID_RANK_SORT_CLS_CODE: '0'
    }
  );

  if (!json || !Array.isArray(json.output)) return [];

  return json.output.slice(0, 20).map(row => ({
    // 필드명은 실제 응답을 콘솔 로그로 한 번 확인 후 정확히 맞출 것
    name: row.hts_kor_isnm,
    netBuyAmount: row.frgn_ntby_qty || row.ntby_qty,
    currentPrice: row.stck_prpr
  }));
}

// ── 4. 업종별 등락률 (코스피 업종지수) ─────────────────────────────────
// ✅ 경로/tr_id 확인 완료 (한국투자증권 API 5) [국내주식] 업종/기타 문서 대조)
// 국내업종 구분별전체시세 API — output1(시장 전체 요약) + output2(업종별 배열)를 모두 반환
async function fetchSectorIndices() {
  const json = await callKisGet(
    '/uapi/domestic-stock/v1/quotations/inquire-index-category-price',
    'FHPUP02140000', // ✅ 확인됨
    {
      FID_COND_MRKT_DIV_CODE: 'U',
      FID_INPUT_ISCD: '0001',   // 코스피(0001) / 코스닥(1001) / 코스피200(2001)
      FID_MRKT_CLS_CODE: 'K',   // K: 거래소(코스피), Q: 코스닥, K2: 코스피200
      FID_BLNG_CLS_CODE: '0'    // 0: 전업종
    }
  );

  // output2가 업종별 상세 배열 (output1은 시장 전체 요약이라 여기선 미사용)
  if (!json || !Array.isArray(json.output2)) return [];

  return json.output2.map(row => ({
    sectorName: row.hts_kor_isnm,          // 업종명 (예: "KOSPI200")
    index: row.bstp_nmix_prpr,             // 업종 지수 현재가
    changeRate: row.bstp_nmix_prdy_ctrt,   // 전일 대비율(%)
    volume: row.acml_vol                   // 누적 거래량
  })).sort((a, b) => parseFloat(b.changeRate) - parseFloat(a.changeRate)); // 상승률 높은 순 정렬
}

// 코스닥 업종도 같은 API로 조회 (FID_INPUT_ISCD만 1001로 교체)
async function fetchKosdaqSectorIndices() {
  const json = await callKisGet(
    '/uapi/domestic-stock/v1/quotations/inquire-index-category-price',
    'FHPUP02140000',
    {
      FID_COND_MRKT_DIV_CODE: 'U',
      FID_INPUT_ISCD: '1001',
      FID_MRKT_CLS_CODE: 'Q',
      FID_BLNG_CLS_CODE: '0'
    }
  );
  if (!json || !Array.isArray(json.output2)) return [];
  return json.output2.map(row => ({
    sectorName: row.hts_kor_isnm,
    index: row.bstp_nmix_prpr,
    changeRate: row.bstp_nmix_prdy_ctrt,
    volume: row.acml_vol
  })).sort((a, b) => parseFloat(b.changeRate) - parseFloat(a.changeRate));
}

// ── 5. 투자자별 매매동향 (개인/외국인/기관 순매수, 시장 전체) ────────
// 문서: "국내주식 > 시세 > 국내주식 시간외예상체결등락률" 인접 카테고리의
// "투자자별매매동향(시장전체)" 문서에서 정확한 path/tr_id 확인 필요
async function fetchInvestorFlow(marketCode /* 'KOSPI' | 'KOSDAQ' */) {
  const json = await callKisGet(
    '/uapi/domestic-stock/v1/quotations/inquire-investor-trend', // TODO: 정확한 path 확인
    'FHPTJ04030000', // TODO: 포탈 문서 값으로 검증/교체
    {
      FID_COND_MRKT_DIV_CODE: marketCode === 'KOSDAQ' ? 'Q' : 'J',
      FID_INPUT_ISCD: '0001'
    }
  );

  if (!json || !json.output) return null;

  return {
    market: marketCode,
    individual: json.output.prsn_ntby_qty,
    foreign: json.output.frgn_ntby_qty,
    institution: json.output.orgn_ntby_qty
  };
}

// ── 6. 통합 호출 (gemini-auto-publish.js에서 이거 하나만 부르면 됨) ────
async function fetchKoreaMarketData() {
  console.log('🇰🇷 [KIS API] 국내 수급/업종/외국인매수 데이터 수집 중...');

  const [foreignTop, sectors, kosdaqSectors, kospiFlow, kosdaqFlow] = await Promise.all([
    fetchForeignInstitutionTopBuys().catch(err => { console.warn('  ⚠️ 외국인매수 실패:', err.message); return []; }),
    fetchSectorIndices().catch(err => { console.warn('  ⚠️ 코스피 업종별 실패:', err.message); return []; }),
    fetchKosdaqSectorIndices().catch(err => { console.warn('  ⚠️ 코스닥 업종별 실패:', err.message); return []; }),
    fetchInvestorFlow('KOSPI').catch(err => { console.warn('  ⚠️ 코스피 수급 실패:', err.message); return null; }),
    fetchInvestorFlow('KOSDAQ').catch(err => { console.warn('  ⚠️ 코스닥 수급 실패:', err.message); return null; })
  ]);

  return { foreignTop, sectors, kosdaqSectors, kospiFlow, kosdaqFlow };
}

module.exports = { fetchKoreaMarketData };