/**
 * scripts/backfill-market-data.js
 * 8/14 ~ 9/9 기간 주식 브리핑의 본문 텍스트에서 수치를 파싱하여 market_data 컬럼 일괄 UPDATE
 */

const { loadEnvConfig } = require('@next/env');
loadEnvConfig(process.cwd());

const { createClient } = require('@supabase/supabase-js');

const rawUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '').trim();

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function parseMetric(text, namePattern) {
  // 예: "다우: 52,786.07 (-1.18%)" 또는 "다우존스산업평균지수는 전 거래일 대비 1.18% 하락한 52,786.07" 등 유연 매칭
  const regex1 = new RegExp(`${namePattern}[^:\\d]*:[\\s]*([\\d,.]+)[\\s]*\\(([+-]?[\\d,.]+%)`, 'i');
  const match1 = text.match(regex1);
  if (match1) return { price: match1[1], change: match1[2] };

  const regex2 = new RegExp(`([\\d,.]+%)\\s*(?:상승|하락|급등|급락)한\\s*([\\d,.]+)`, 'i');
  if (new RegExp(namePattern, 'i').test(text)) {
    const match2 = text.match(regex2);
    if (match2) {
      const isDown = /하락|급락/.test(text);
      const sign = isDown ? '-' : '+';
      const cleanChange = match2[1].replace(/[+-]/, '');
      return { price: match2[2], change: `${sign}${cleanChange}` };
    }
  }
  return null;
}

async function backfill() {
  console.log('🔄 8/14 ~ 9/9 주식 브리핑 market_data 백필 시작...');

  const { data: rows, error } = await supabase
    .from('briefings')
    .select('id, briefing_date, sections, market_data')
    .eq('category_type', 'stock')
    .gte('briefing_date', '2026-08-14')
    .lte('briefing_date', '2026-09-09')
    .order('briefing_date', { ascending: true });

  if (error) {
    console.error('❌ 데이터 조회 실패:', error.message);
    process.exit(1);
  }

  console.log(`📋 대상 데이터: 총 ${rows.length}건`);

  for (const row of rows) {
    const marketData = {};
    const items = row.sections?.flatMap(s => s.items || []) || [];

    for (const item of items) {
      const txt = item.text || '';

      if (!marketData.dow) {
        const p = parseMetric(txt, '다우');
        if (p) marketData.dow = { symbol: '^DJI', ...p };
      }
      if (!marketData.sp500) {
        const p = parseMetric(txt, 'S&P\\s*500');
        if (p) marketData.sp500 = { symbol: '^GSPC', ...p };
      }
      if (!marketData.nasdaq) {
        const p = parseMetric(txt, '나스닥');
        if (p) marketData.nasdaq = { symbol: '^IXIC', ...p };
      }
      if (!marketData.russell) {
        const p = parseMetric(txt, '러셀\\s*2000');
        if (p) marketData.russell = { symbol: '^RUT', ...p };
      }
      if (!marketData.sox) {
        const p = parseMetric(txt, '반도체');
        if (p) marketData.sox = { symbol: '^SOX', ...p };
      }
      if (!marketData.ewy) {
        const p = parseMetric(txt, '한국|EWY');
        if (p) marketData.ewy = { symbol: 'EWY', ...p };
      }
      if (!marketData.usdkrw) {
        const p = parseMetric(txt, '환율|NDF');
        if (p) marketData.usdkrw = { symbol: 'KRW=X', ...p };
      }
    }

    if (Object.keys(marketData).length > 0) {
      const { error: updateErr } = await supabase
        .from('briefings')
        .update({ market_data: marketData })
        .eq('id', row.id);

      if (updateErr) {
        console.warn(`  ⚠️ [${row.briefing_date}] 업데이트 실패:`, updateErr.message);
      } else {
        console.log(`  ✓ [${row.briefing_date}] market_data 복원 완료 (${Object.keys(marketData).length}개 지표)`);
      }
    } else {
      console.log(`  - [${row.briefing_date}] 매칭 지표 없음`);
    }
  }

  console.log('\n🎉 백필 완료!');
  process.exit(0);
}

backfill();