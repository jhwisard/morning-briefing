'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { 
  Newspaper, TrendingUp, Sparkles, Calendar, Lock, 
  CheckCircle2, AlertCircle, ArrowLeft, Send, RefreshCw, 
  FileText, SunMedium, Eye, Wand2, RotateCcw, Bot
} from 'lucide-react';
import Link from 'next/link';

// 관리자 접속 비밀번호
const ADMIN_SECRET = 'admin1234';

interface NewsItem {
  text: string;
  source: string;
}

interface BriefingSection {
  id: string;
  category: string;
  icon: string;
  items: NewsItem[];
}

export default function AdminPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [authError, setAuthError] = useState(false);

  // 폼 입력 상태
  const [categoryType, setCategoryType] = useState<'news' | 'stock'>('stock');
  const [briefingDate, setBriefingDate] = useState(() => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  });
  const [title, setTitle] = useState('');
  const [weather, setWeather] = useState('');
  const [highlightsText, setHighlightsText] = useState('');
  const [rawText, setRawText] = useState('');

  // 파싱된 최종 데이터 구조
  const [parsedSections, setParsedSections] = useState<BriefingSection[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 비밀번호 확인
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordInput === ADMIN_SECRET) {
      setIsAuthenticated(true);
      setAuthError(false);
    } else {
      setAuthError(true);
    }
  };

  // 폼 초기화 (Reset)
  const handleReset = () => {
    if (rawText && !confirm('입력한 내용과 파싱 결과를 모두 초기화하시겠습니까?')) {
      return;
    }
    setRawText('');
    setTitle('');
    setWeather('');
    setHighlightsText('');
    setParsedSections([]);
    setStatusMsg(null);
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    setBriefingDate(`${yyyy}-${mm}-${dd}`);
  };

  // 고성능 지능형 자동 파서 (수동 텍스트 붙여넣기용)
  const handleAutoParse = () => {
    if (!rawText.trim()) {
      alert('붙여넣을 브리핑 본문 텍스트를 입력해 주세요.');
      return;
    }

    setIsParsing(true);
    setStatusMsg(null);

    // [전처리] 탭 제거 및 기호 앞 개행 보정
    let normalizedText = rawText
      .replace(/\t/g, ' ')
      .replace(/([^\n])◐/g, '$1\n◐')
      .replace(/([^\n])⚬/g, '$1\n⚬')
      .replace(/([^\n])(\[美|\[中|\[러|\[英|\[日|\[한국|\[스포츠|\[날씨)/g, '$1\n$2')
      .replace(/([^\n])(1\.\s*해외|2\.\s*(?:오늘의\s*)?증시\s*키워드|3\.\s*주요|4\.\s*(?:오늘의\s*)?시황)/g, '$1\n$2');

    const lines = normalizedText
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    // [A] 카테고리 자동 감지
    let detectedType: 'news' | 'stock' = categoryType;
    if (normalizedText.includes('주식 모닝 브리핑') || normalizedText.includes('해외 증시') || normalizedText.includes('다우 지수') || normalizedText.includes('S&P 500')) {
      detectedType = 'stock';
      setCategoryType('stock');
    } else if (normalizedText.includes('[美미국]') || normalizedText.includes('간추린 뉴스')) {
      detectedType = 'news';
      setCategoryType('news');
    }

    // [B] 날짜 및 요일 정밀 추출
    const currentDateParts = briefingDate.split('-');
    let parsedYear = currentDateParts[0];
    let parsedMonth = currentDateParts[1];
    let parsedDay = currentDateParts[2];
    let parsedDayOfWeek = '';

    const dateMatch = normalizedText.match(/(?:'|20)?(\d{2})[-/.년]\s*(\d{1,2})[-/.월]\s*(\d{1,2})/);
    const dayMatch = normalizedText.match(/\(([월화수목금토일])\)/);

    if (dateMatch) {
      const y = dateMatch[1].length === 2 ? `20${dateMatch[1]}` : dateMatch[1];
      const m = String(parseInt(dateMatch[2])).padStart(2, '0');
      const d = String(parseInt(dateMatch[3])).padStart(2, '0');
      parsedYear = y;
      parsedMonth = m;
      parsedDay = d;
      setBriefingDate(`${y}-${m}-${d}`);
    }

    if (dayMatch) {
      parsedDayOfWeek = `(${dayMatch[1]})`;
    }

    // [C] 브리핑 표준 제목 생성
    const cleanTitle = detectedType === 'news'
      ? `${parsedYear}년 ${parseInt(parsedMonth)}월 ${parseInt(parsedDay)}일${parsedDayOfWeek} 간추린 뉴스`
      : `${parsedYear}년 ${parseInt(parsedMonth)}월 ${parseInt(parsedDay)}일${parsedDayOfWeek} 주식 모닝 브리핑`;
    setTitle(cleanTitle);

    // [D] 섹션 및 본문 파싱
    const sections: BriefingSection[] = [];
    let currentSec: BriefingSection | null = null;
    const extractedHighlights: string[] = [];
    let extractedWeather = '';
    let dowVal = '', spVal = '', nasVal = '';

    if (detectedType === 'news') {
      // 1. 간추린 뉴스 파싱
      lines.forEach((line) => {
        if (line.startsWith('[') && line.includes(']')) {
          const catName = line.replace(/[\[\]]/g, '').trim();
          if (catName.includes('날씨')) {
            currentSec = null;
          } else {
            currentSec = {
              id: `sec_${sections.length + 1}`,
              category: catName,
              icon: 'Globe',
              items: []
            };
            sections.push(currentSec);
          }
        } else if (line.startsWith('◐') || line.startsWith('⚬') || line.startsWith('-')) {
          let cleanLine = line.replace(/^[◐⚬\-*]\s*/, '').trim();

          if (line.includes('체감') || line.includes('기온') || line.includes('폭염') || line.includes('소나기') || line.includes('날씨')) {
            extractedWeather = cleanLine;
            return;
          }

          let source = '종합';
          const matchSource = cleanLine.match(/\((?:출처:\s*)?([^)]+)\)$/);
          if (matchSource) {
            source = matchSource[1].replace(/^출처:\s*/, '').trim();
            cleanLine = cleanLine.replace(/\((?:출처:\s*)?([^)]+)\)$/, '').trim();
          }

          if (currentSec) {
            currentSec.items.push({ text: cleanLine, source });
            if (extractedHighlights.length < 3) {
              extractedHighlights.push(cleanLine);
            }
          }
        }
      });
    } else {
      // 2. 주식 모닝 브리핑 전용 정밀 파서
      let tempHeadline = '';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const topMatch = line.match(/^(1\.\s*해외\s*증시[^\n]*|2\.\s*(?:오늘의\s*)?증시\s*키워드[^\n]*|3\.\s*주요\s*(?:주식\s*)?뉴스[^\n]*|4\.\s*(?:오늘의\s*)?시황\s*(?:요약)?[^\n]*)/);

        if (topMatch) {
          if (tempHeadline && currentSec) {
            currentSec.items.push({ text: tempHeadline, source: '증시 뉴스' });
            tempHeadline = '';
          }

          currentSec = {
            id: `sec_${sections.length + 1}`,
            category: topMatch[1].trim(),
            icon: 'TrendingUp',
            items: []
          };
          sections.push(currentSec);
          continue;
        }

        if (!currentSec) continue;

        // [3. 주요 주식 뉴스] 섹션: ◐ 헤드라인과 이어지는 설명(:, ⚬, -, ▶ 등) 한 줄 결합
        if (currentSec.category.includes('주요') || currentSec.category.includes('뉴스')) {
          if (line.startsWith('◐')) {
            // 이전에 처리되지 않은 헤드라인이 남아있다면 먼저 저장
            if (tempHeadline) {
              let headSource = '증시 뉴스';
              let cleanHead = tempHeadline;
              const matchSource = cleanHead.match(/\((?:출처:\s*)?([^)]+)\)$/);
              if (matchSource) {
                headSource = matchSource[1].replace(/^출처:\s*/, '').trim();
                cleanHead = cleanHead.replace(/\((?:출처:\s*)?([^)]+)\)$/, '').trim();
              }
              currentSec.items.push({ text: cleanHead, source: headSource });
            }
            tempHeadline = line.replace(/^◐\s*/, '').trim();
          } else {
            // 콜론(:), ⚬, -, *, ▶, · 등 모든 하위 불릿 기호 제거 및 상세 텍스트 추출
            let detail = line.replace(/^[:\s⚬\-*○▶▷·ㆍ]+\s*/, '').trim();
            if (!detail) continue;

            let source = '증시 시황';
            const matchSource = detail.match(/\((?:출처:\s*)?([^)]+)\)$/);
            if (matchSource) {
              source = matchSource[1].replace(/^출처:\s*/, '').trim();
              detail = detail.replace(/\((?:출처:\s*)?([^)]+)\)$/, '').trim();
            }

            if (tempHeadline) {
              // 💡 헤드라인과 상세설명을 한 줄로 병합
              currentSec.items.push({
                text: `${tempHeadline}: ${detail}`,
                source
              });
              tempHeadline = '';
            } else {
              currentSec.items.push({ text: detail, source });
            }
          }
          continue;
        }

        // [1. 해외증시] 항목 처리
        if (currentSec.category.includes('해외 증시')) {
          let cleanLine = line.replace(/^[◐⚬\-*]\s*/, '').trim();
          let source = '뉴욕증시';
          if (cleanLine.includes('다우')) { source = '다우'; dowVal = cleanLine; }
          else if (cleanLine.includes('S&P')) { source = 'S&P500'; spVal = cleanLine; }
          else if (cleanLine.includes('나스닥')) { source = '나스닥'; nasVal = cleanLine; }
          else if (cleanLine.includes('반도체')) { source = '반도체'; }
          else if (cleanLine.includes('러셀')) { source = '소형주'; }
          else if (cleanLine.includes('MSCI') || cleanLine.includes('야간')) { source = '한국물'; }

          currentSec.items.push({ text: cleanLine, source });
          continue;
        }

        // [2. 오늘의 증시 키워드] 항목 처리
        if (currentSec.category.includes('키워드')) {
          let cleanLine = line.replace(/^[◐⚬\-*]\s*/, '').replace(/^\d+\.\s*/, '').trim();
          currentSec.items.push({ text: cleanLine, source: '핵심 키워드' });
          extractedHighlights.push(cleanLine);
          continue;
        }

        // [4. 오늘의 시황 요약] 항목 처리
        if (currentSec.category.includes('시황')) {
          let cleanLine = line.replace(/^[◐⚬\-*]\s*/, '').replace(/^\d+\.\s*/, '').trim();
          currentSec.items.push({ text: cleanLine, source: '시황 분석' });
          continue;
        }
      }

      if (tempHeadline && currentSec) {
        currentSec.items.push({ text: tempHeadline, source: '증시 뉴스' });
      }

      // 3대 지수 기반 한 줄 요약 동적 조합 (하드코딩 제거)
      if (dowVal || spVal || nasVal) {
        const dMatch = dowVal.match(/\(([+-]?\d+\.?\d*%)\)/);
        const sMatch = spVal.match(/\(([+-]?\d+\.?\d*%)\)/);
        const nMatch = nasVal.match(/\(([+-]?\d+\.?\d*%)\)/);
        const dRate = dMatch ? `다우 ${dMatch[1]}` : '';
        const sRate = sMatch ? `S&P500 ${sMatch[1]}` : '';
        const nRate = nMatch ? `나스닥 ${nMatch[1]}` : '';
        const rates = [dRate, sRate, nRate].filter(Boolean).join(' · ');
        extractedWeather = rates ? `${rates} (글로벌 증시 주요 지표)` : '';
      }
    }

    setParsedSections(sections);
    if (extractedWeather) setWeather(extractedWeather);
    if (extractedHighlights.length > 0) {
      setHighlightsText(extractedHighlights.join('\n'));
    }

    setIsParsing(false);
    setStatusMsg({ 
      type: 'success', 
      text: `✨ [${parsedYear}-${parsedMonth}-${parsedDay}] ${detectedType === 'news' ? '간추린 뉴스' : '주식 모닝 브리핑'} 파싱 성공! (총 ${sections.length}개 섹션)` 
    });
  };

  // Supabase DB에 최종 발행
  const handlePublish = async () => {
    if (!briefingDate || !title) {
      alert('날짜와 제목을 입력해 주세요.');
      return;
    }
    if (parsedSections.length === 0) {
      alert('파싱된 데이터가 없습니다. 먼저 [자동 파싱 실행]을 눌러주세요.');
      return;
    }

    setIsSaving(true);
    setStatusMsg(null);

    const highlights = highlightsText
      .split('\n')
      .map(h => h.trim())
      .filter(Boolean);

    try {
      await supabase
        .from('briefings')
        .delete()
        .eq('briefing_date', briefingDate)
        .eq('category_type', categoryType);

      const { error } = await supabase.from('briefings').insert([
        {
          briefing_date: briefingDate,
          category_type: categoryType,
          title: title,
          weather: weather || null,
          highlights: highlights,
          sections: parsedSections
        }
      ]);

      if (error) throw error;

      setStatusMsg({ 
        type: 'success', 
        text: `🎉 [${briefingDate}] ${categoryType === 'news' ? '간추린 뉴스' : '주식 모닝 브리핑'} 발행이 성공적으로 완료되었습니다!` 
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err: any) {
      console.error(err);
      setStatusMsg({ type: 'error', text: `발행 실패: ${err.message || '데이터베이스 오류'}` });
    } finally {
      setIsSaving(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
        <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-5">
          <div className="text-center space-y-2">
            <div className="w-12 h-12 bg-sky-500/20 text-sky-400 rounded-xl flex items-center justify-center mx-auto">
              <Lock className="w-6 h-6" />
            </div>
            <h1 className="text-lg font-bold text-white">모닝 브리핑 관리자</h1>
            <p className="text-xs text-slate-400">발행 시스템에 접근하려면 비밀번호를 입력하세요.</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-3">
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="관리자 비밀번호 입력 (admin1234)"
              className="w-full px-4 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
              autoFocus
            />
            {authError && (
              <p className="text-xs text-rose-400 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" /> 비밀번호가 일치하지 않습니다.
              </p>
            )}
            <button
              type="submit"
              className="w-full py-2.5 bg-sky-600 hover:bg-sky-500 text-white font-bold rounded-xl text-sm transition shadow-lg shadow-sky-600/30"
            >
              접속하기
            </button>
          </form>
          <div className="text-center">
            <Link href="/" className="text-xs text-slate-500 hover:text-slate-300">
              ← 사용자 브리핑 화면으로 돌아가기
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans pb-20 antialiased">
      
      {/* Sticky Header */}
      <header className="sticky top-0 z-30 bg-slate-900/95 backdrop-blur-md border-b border-slate-800 px-4 py-3 shadow-md">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Link href="/" className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <h1 className="text-base font-bold text-white flex items-center gap-2">
              <Wand2 className="w-5 h-5 text-sky-400" />
              스마트 원클릭 브리핑 발행기
            </h1>
          </div>
          <Link
            href="/"
            target="_blank"
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-sky-400 flex items-center gap-1.5 transition"
          >
            <Eye className="w-3.5 h-3.5" /> 라이브 웹 확인
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 pt-5 space-y-5">
        
        {/* 상단 통합 제어 바 */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleReset}
                className="px-3 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl text-xs flex items-center gap-1.5 border border-slate-700 transition"
                title="입력 내용 전체 비우기"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                초기화
              </button>
              <button
                type="button"
                onClick={handleAutoParse}
                disabled={isParsing}
                className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 shadow-lg shadow-indigo-600/30 transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isParsing ? 'animate-spin' : ''}`} />
                자동 파싱 실행
              </button>
            </div>

            <button
              type="button"
              onClick={handlePublish}
              disabled={isSaving || parsedSections.length === 0}
              className="flex-1 sm:flex-initial px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-sm rounded-xl shadow-lg shadow-emerald-600/30 flex items-center justify-center gap-2 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send className="w-4 h-4" />
              <span>{isSaving ? '데이터베이스 저장 중...' : '🚀 이 내용으로 즉시 발행하기'}</span>
            </button>
          </div>

          {/* 발행 상태 알림 배너 */}
          {statusMsg && (
            <div className={`p-3.5 rounded-xl text-xs sm:text-sm font-semibold flex items-center gap-2.5 shadow-md animate-fade-in ${
              statusMsg.type === 'success' 
                ? 'bg-emerald-950/90 border border-emerald-500/60 text-emerald-300' 
                : 'bg-rose-950/90 border border-rose-500/60 text-rose-300'
            }`}>
              {statusMsg.type === 'success' ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              ) : (
                <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
              )}
              <span className="leading-snug">{statusMsg.text}</span>
            </div>
          )}
        </section>

        {/* 1. 텍스트 입력 영역 */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold text-sky-400 flex items-center gap-1.5">
              <FileText className="w-4 h-4" />
              1. 원본 텍스트 붙여넣기 (뉴스 or 주식 브리핑)
            </label>
            <span className="text-[11px] text-slate-500">
              붙여넣고 상단 [자동 파싱 실행] 클릭
            </span>
          </div>
          <textarea
            rows={10}
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder={`여기에 아침 뉴스 또는 주식 브리핑 텍스트를 그대로 복사해서 붙여넣으세요.`}
            className="w-full p-4 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-slate-300 focus:outline-none focus:ring-2 focus:ring-sky-500 placeholder-slate-700 leading-relaxed"
          />
        </section>

        {/* 2. 파싱 메타데이터 검토 및 수정 영역 */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
          <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
            2. 자동 파싱된 메타 정보 (수정 가능)
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1.5">카테고리</label>
              <div className="grid grid-cols-2 gap-2 p-1 bg-slate-950 rounded-xl border border-slate-800">
                <button
                  type="button"
                  onClick={() => setCategoryType('news')}
                  className={`py-2 text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 transition ${
                    categoryType === 'news' ? 'bg-sky-600 text-white shadow' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <Newspaper className="w-4 h-4" /> 간추린 뉴스
                </button>
                <button
                  type="button"
                  onClick={() => setCategoryType('stock')}
                  className={`py-2 text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 transition ${
                    categoryType === 'stock' ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <TrendingUp className="w-4 h-4" /> 주식 모닝 브리핑
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1.5">발행 날짜</label>
              <div className="relative">
                <Calendar className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="date"
                  value={briefingDate}
                  onChange={(e) => setBriefingDate(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500 font-mono"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-400 mb-1.5">브리핑 제목</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="예: 2026년 8월 19일(수) 주식 모닝 브리핑"
              className="w-full px-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500 placeholder-slate-700 font-medium"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-400 mb-1.5">마켓 한 줄 요약 / 날씨</label>
            <div className="relative">
              <SunMedium className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-amber-400" />
              <input
                type="text"
                value={weather}
                onChange={(e) => setWeather(e.target.value)}
                placeholder="예: 다우 +0.24% · S&P500 +0.42% · 나스닥 +0.58% (기술주 중심 반등 속 관망세)"
                className="w-full pl-10 pr-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500 placeholder-slate-700"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-400 mb-1.5">
              핵심 3~4줄 요약 (엔터로 줄바꿈)
            </label>
            <textarea
              rows={4}
              value={highlightsText}
              onChange={(e) => setHighlightsText(e.target.value)}
              placeholder="1. 첫 번째 핵심 키워드&#10;2. 두 번째 핵심 키워드&#10;3. 세 번째 핵심 키워드"
              className="w-full px-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs sm:text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500 placeholder-slate-700 leading-relaxed"
            />
          </div>
        </section>

        {/* 3. 파싱 결과 미리보기 */}
        {parsedSections.length > 0 && (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                3. 파싱된 섹션 미리보기 ({parsedSections.length}개 섹션)
              </h2>
              <span className="text-xs text-emerald-400 font-mono">발행 대기 중</span>
            </div>

            <div className="space-y-3">
              {parsedSections.map((sec, idx) => (
                <div key={sec.id || idx} className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-2">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <span className="text-xs font-bold text-sky-400">{sec.category}</span>
                    <span className="text-[10px] text-slate-500 font-mono">{sec.items.length}개 항목</span>
                  </div>
                  <ul className="space-y-1.5">
                    {sec.items.map((item, itemIdx) => (
                      <li key={itemIdx} className="text-xs text-slate-300 flex items-start gap-2">
                        <span className="text-sky-500 font-bold">◐</span>
                        <span className="flex-1">{item.text}</span>
                        <span className="text-[10px] text-slate-500 shrink-0">[{item.source}]</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
