/**
 * scripts/test-kis-connection.js
 *
 * KIS appkey/appsecret이 정상 발급됐는지, 그리고 실제 데이터 조회까지 되는지
 * 한 번에 확인하는 테스트 전용 스크립트. 이게 통과하면 fetch-korea-market.js도
 * 정상 작동할 거라고 확신할 수 있음.
 *
 * 실행: KIS_APP_KEY=xxx KIS_APP_SECRET=yyy node scripts/test-kis-connection.js
 * 또는 .env.local에 KIS_APP_KEY / KIS_APP_SECRET 넣어두고: node scripts/test-kis-connection.js
 */

const { loadEnvConfig } = require('@next/env');
loadEnvConfig(process.cwd());

const KIS_BASE_URL = 'https://openapi.koreainvestment.com:9443';
const KIS_APP_KEY = process.env.KIS_APP_KEY?.trim();
const KIS_APP_SECRET = process.env.KIS_APP_SECRET?.trim();

if (!KIS_APP_KEY || !KIS_APP_SECRET) {
  console.error('❌ KIS_APP_KEY / KIS_APP_SECRET 환경변수가 없습니다.');
  console.error('   실행 예: KIS_APP_KEY=xxx KIS_APP_SECRET=yyy node scripts/test-kis-connection.js');
  process.exit(1);
}

async function step1_getToken() {
  console.log('1️⃣  토큰 발급 시도 중...');
  const res = await fetch(`${KIS_BASE_URL}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET
    })
  });

  const json = await res.json();

  if (!res.ok || !json.access_token) {
    console.error('❌ 토큰 발급 실패');
    console.error('   HTTP 상태:', res.status);
    console.error('   응답 내용:', JSON.stringify(json, null, 2));
    console.error('\n   흔한 원인:');
    console.error('   - appkey/appsecret에 앞뒤 공백이나 줄바꿈이 섞여 들어감 (복사할 때 흔함)');
    console.error('   - 포탈에서 앱을 "모의투자" 계좌로 등록했는데 실전 도메인(openapi.koreainvestment.com)으로 요청함 → 모의투자면 openapivts.koreainvestment.com:29443 사용');
    console.error('   - 앱 등록 후 반영까지 몇 분 걸리는 경우가 있음 (5분 후 재시도)');
    process.exit(1);
  }

  console.log('✅ 토큰 발급 성공!');
  console.log(`   토큰 앞부분: ${json.access_token.slice(0, 20)}...`);
  console.log(`   유효기간: ${json.expires_in}초 (${(json.expires_in / 3600).toFixed(1)}시간)`);
  console.log('   → 등록된 휴대폰으로 "토큰발급 알림톡"이 왔는지 확인해보세요.\n');

  return json.access_token;
}

async function step2_fetchSectorData(token) {
  console.log('2️⃣  실제 데이터 조회 시도 중 (코스피 업종별 지수)...');

  const params = new URLSearchParams({
    FID_COND_MRKT_DIV_CODE: 'U',
    FID_COND_SCR_DIV_CODE: '20174', // 👈 이 줄 추가 (조건 화면 분류 코드)
    FID_INPUT_ISCD: '0001',
    FID_MRKT_CLS_CODE: 'K',
    FID_BLNG_CLS_CODE: '0'
  });

  const res = await fetch(
    `${KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-index-category-price?${params}`,
    {
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${token}`,
        'appkey': KIS_APP_KEY,
        'appsecret': KIS_APP_SECRET,
        'tr_id': 'FHPUP02140000',
        'custtype': 'P'
      }
    }
  );

  const json = await res.json();

  if (!res.ok || json.rt_cd !== '0') {
    console.error('❌ 데이터 조회 실패');
    console.error('   HTTP 상태:', res.status);
    console.error('   응답 내용:', JSON.stringify(json, null, 2));
    console.error('\n   흔한 원인:');
    console.error('   - 장 마감 후/주말이라 일부 필드가 비어있을 수 있음 (rt_cd가 0이면 괜찮음)');
    console.error('   - tr_id가 이 계정/앱에 권한이 없는 경우 (포탈에서 해당 API 문서 페이지 재확인)');
    process.exit(1);
  }

  console.log('✅ 데이터 조회 성공!');
  console.log(`   반환된 업종 수: ${json.output2?.length ?? 0}개`);
  if (json.output2?.length) {
    const sample = json.output2.slice(0, 3);
    console.log('   샘플 3개:');
    sample.forEach(row => {
      console.log(`     - ${row.hts_kor_isnm}: 지수 ${row.bstp_nmix_prpr}, 등락률 ${row.bstp_nmix_prdy_ctrt}%`);
    });
  }

  console.log('\n🎉 전체 테스트 통과! appkey/appsecret이 정상 작동하고, 실제 데이터도 정상 조회됩니다.');
  console.log('   → 이제 fetch-korea-market.js를 gemini-auto-publish.js에 연결해도 안전합니다.');
}

async function main() {
  const token = await step1_getToken();
  await step2_fetchSectorData(token);
}

main().catch(err => {
  console.error('💥 테스트 중 예외 발생:', err);
  process.exit(1);
});