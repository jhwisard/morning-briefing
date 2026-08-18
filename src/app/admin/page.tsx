'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { 
  Newspaper, TrendingUp, Sparkles, Calendar, Lock, 
  CheckCircle2, AlertCircle, ArrowLeft, Send, RefreshCw, 
  FileText, SunMedium, Eye, Wand2
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
  const [categoryType, setCategoryType] = useState<'news' | 'stock'>('news');
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
  const [isSaving, setIsSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 1. 비밀번호 확인
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordInput === ADMIN_SECRET) {
      setIsAuthenticated(true);
      setAuthError(false);
    } else {
      setAuthError(true);
    }
  };

  // 2. 고성능 지능형 자동 파서 (날짜/제목/카테고리/날씨/하이라이트 정밀 추출)
  const handleAutoParse = () => {
    if (!rawText.trim()) {
      alert('붙여넣을 브리핑 본문 텍스트를 입력해 주세요.');
      return;
    }

    setIsParsing(true);
    const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

    // [A] 카테고리 자동 감지 (주식 vs 뉴스)
    let detectedType = categoryType;
    if (rawText.includes('주식 모닝 브리핑') || rawText.includes('해외 증시') || rawText.includes('다우 지수') || rawText.includes('S&P 500')) {
      detectedType = 'stock';
      setCategoryType('stock');
    } else if (rawText.includes('[美미국]') || rawText.includes('간추린 뉴스')) {
      detectedType = 'news';
      setCategoryType('news');
    }

    // [B] 날짜 및 요일 정밀 추출 ('26-8/18(화), 2026.8.18, 2026-08-18 등 모두 대응)
    let parsedYear = '2026';
    let parsedMonth = '08';
    let parsedDay = '18';
    let parsedDayOfWeek = '';

    // 날짜 정규식 패턴: '26-8/18 또는 2026-8-18 또는 2026.8.18
    const dateMatch = rawText.match(/(?:'|20)?(\d{2})[-/.년]\s*(\d{1,2})[-/.월]\s*(\d{1,2})/);
    // 요일 정규식 패턴: (월), (화), (수), (목), (금), (토), (일)
    const dayMatch = rawText.match(/\(([월화수목금토일])\)/);

    if (dateMatch) {
      const y = dateMatch[1].length === 2 ? `20${dateMatch[1]}` : dateMatch[1];
      const m = String(parseInt(dateMatch[2])).padStart(2, '0');
      const d = String(parseInt(dateMatch[3])).padStart(2, '0');
      parsedYear = y;
      parsedMonth = m;
      parsedDay = d;
      const fullDateStr = `${y}-${m}-${d}`;
      setBriefingDate(fullDateStr);
    }

    if (dayMatch) {
      parsedDayOfWeek = `(${dayMatch[1]})`;
    }

    // [C] 브리핑 표준 제목 자동 생성
    const cleanTitle = detectedType === 'news'
      ? `${parsedYear}년 ${parseInt(parsedMonth)}월 ${parseInt(parsedDay)}일${parsedDayOfWeek} 간추린 종합 뉴스`
      : `${parsedYear}년 ${parseInt(parsedMonth)}월 ${parseInt(parsedDay)}일${parsedDayOfWeek} 주식 & 글로벌 마켓 모닝 브리핑`;
    setTitle(cleanTitle);

    // [D] 섹션 및 본문 파싱
    const sections: BriefingSection[] = [];
    let currentSec: BriefingSection | null = null;
    const extractedHighlights: string[] = [];
    let extractedWeather = '';

    if (detectedType === 'news') {
      // 간추린 뉴스 파싱 ([미국], [한국.경제], [날씨] 등)
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

          // [날씨] 섹션의 텍스트 처리
          if (line.includes('체감') || line.includes('기온') || line.includes('폭염') || line.includes('소나기') || line.includes('날씨')) {
            extractedWeather = cleanLine;
            return;
          }

          // 출처 추출 (출처: ...)
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
      // 주식 모닝 브리핑 파싱 (1. 해외 증시 / 2. 오늘의 증시 키워드 / 3. 주요 주식 뉴스 / 4. 시황 요약)
      lines.forEach((line) => {
        // 섹션 제목 매칭 (1. 2. 3. 4. 로 시작하는 라인)
        if (/^[1-9]\.\s+/.test(line)) {
          const secTitle = line.trim();
          currentSec = {
            id: `sec_${sections.length + 1}`,
            category: secTitle,
            icon: 'TrendingUp',
            items: []
          };
          sections.push(currentSec);
        } else if (line.startsWith('⚬') || line.startsWith('◐') || /^[1-9]\.\s*/.test(line) || line.startsWith('-')) {
          let cleanLine = line.replace(/^[◐⚬\-*]\s*/, '').replace(/^[1-9]\.\s*/, '').trim();

          // 첫 번째 해외증시 지수 라인인 경우 마켓 서브타이틀로 활용
          if (sections.length === 1 && !extractedWeather && (line.includes('다우') || line.includes('S&P'))) {
            extractedWeather = cleanLine;
          }

          let source = '증시 시황';
          const matchSource = cleanLine.match(/\((?:출처:\s*)?([^)]+)\)$/);
          if (matchSource) {
            source = matchSource[1].replace(/^출처:\s*/, '').trim();
            cleanLine = cleanLine.replace(/\((?:출처:\s*)?([^)]+)\)$/, '').trim();
          }

          if (currentSec) {
            currentSec.items.push({ text: cleanLine, source });
            // 2번 '증시 키워드' 섹션 항목들을 핵심 3줄 요약으로 추출
            if (currentSec.category.includes('키워드') && extractedHighlights.length < 3) {
              extractedHighlights.push(cleanLine);
            }
          }
        }
      });
    }

    setParsedSections(sections);
    if (extractedWeather) setWeather(extractedWeather);
    if (extractedHighlights.length > 0) {
      setHighlightsText(extractedHighlights.join('\n'));
    }

    setIsParsing(false);
    setStatusMsg({ 
      type: 'success', 
      text: `✨ [${parsedYear}-${parsedMonth}-${parsedDay}] ${detectedType === 'news' ? '간추린 뉴스' : '주식 브리핑'} 파싱 성공! (섹션: ${sections.length}개)` 
    });
  };

  // 3. Supabase DB에 최종 발행 (Upsert)
  const handlePublish = async () => {
    if (!briefingDate || !title) {
      alert('날짜와 제목을 입력해 주세요.');
      return;
    }
    if (parsedSections.length === 0) {
      alert('파싱된 섹션 데이터가 없습니다. 먼저 [자동 파싱 실행]을 눌러주세요.');
      return;
    }

    setIsSaving(true);
    setStatusMsg(null);

    const highlights = highlightsText
      .split('\n')
      .map(h => h.trim())
      .filter(Boolean);

    try {
      // 기존 날짜 + 카테고리 데이터 삭제 후 새로 등록
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
        text: `🎉 [${briefingDate}] ${categoryType === 'news' ? '간추린 뉴스' : '주식 브리핑'} 발행이 성공적으로 완료되었습니다!` 
      });
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
      {/* Header */}
      <header className="sticky top-0 z-30 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-4 py-3">
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

      <main className="max-w-4xl mx-auto px-4 pt-6 space-y-6">
        
        {/* Status Toast */}
        {statusMsg && (
          <div className={`p-4 rounded-xl text-xs sm:text-sm font-semibold flex items-center gap-2.5 shadow-lg ${
            statusMsg.type === 'success' ? 'bg-emerald-950/90 border border-emerald-500/50 text-emerald-300' : 'bg-rose-950/90 border border-rose-500/50 text-rose-300'
          }`}>
            {statusMsg.type === 'success' ? <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" /> : <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />}
            <span>{statusMsg.text}</span>
          </div>
        )}

        {/* Input Form */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-5">
          
          {/* Step 1: Text Paste Area */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-sky-400 flex items-center gap-1.5">
                <FileText className="w-4 h-4" />
                1. 원본 텍스트 붙여넣기 (뉴스 or 주식 브리핑)
              </label>
              <button
                type="button"
                onClick={handleAutoParse}
                disabled={isParsing}
                className="px-4 py-2 bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 shadow-lg shadow-sky-500/20 transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isParsing ? 'animate-spin' : ''}`} />
                자동 파싱 실행
              </button>
            </div>
            <textarea
              rows={10}
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder={`여기에 뉴스나 주식 브리핑 텍스트를 그대로 복사해서 붙여넣고 [자동 파싱 실행]을 누르세요.\n\n(예시)\n간추린 뉴스 - '26-8/18(화) 간추린 뉴스\n[美미국]\n◐ 트럼프 행정부, 한미 훈련 축소 검토. (출처: 워싱턴포스트)\n\n(또는 주식)\n📈 주식 모닝 브리핑 - '26-8/18(화)\n1. 해외 증시 마감 현황\n⚬ 다우 지수: 53,810.15 (+0.14%)`}
              className="w-full p-4 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-slate-300 focus:outline-none focus:ring-2 focus:ring-sky-500 placeholder-slate-700 leading-relaxed"
            />
          </div>

          <div className="border-t border-slate-800 pt-5 space-y-4">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              2. 자동 감지 및 파싱된 메타 정보 (수정 가능)
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Category Select */}
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

              {/* Date Picker */}
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

            {/* Title Input */}
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1.5">브리핑 제목</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: 2026년 8월 18일(화) 간추린 종합 뉴스"
                className="w-full px-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500 placeholder-slate-700"
              />
            </div>

            {/* Weather / Subtitle */}
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1.5">날씨 또는 마켓 한줄 요약</label>
              <div className="relative">
                <SunMedium className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-amber-400" />
                <input
                  type="text"
                  value={weather}
                  onChange={(e) => setWeather(e.target.value)}
                  placeholder="예: 전국 대부분 체감 33~35°C 폭염특보 지속 ☀️"
                  className="w-full pl-10 pr-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500 placeholder-slate-700"
                />
              </div>
            </div>

            {/* Highlights 3 Lines */}
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1.5">
                핵심 3줄 요약 (엔터로 줄바꿈)
              </label>
              <textarea
                rows={3}
                value={highlightsText}
                onChange={(e) => setHighlightsText(e.target.value)}
                placeholder="1. 첫 번째 핵심 키워드&#10;2. 두 번째 핵심 키워드&#10;3. 세 번째 핵심 키워드"
                className="w-full px-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs sm:text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500 placeholder-slate-700 leading-relaxed"
              />
            </div>
          </div>
        </div>

        {/* Parsed Preview & Final Publish Button */}
        {parsedSections.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                3. 파싱 결과 미리보기 ({parsedSections.length}개 섹션)
              </h2>
              <span className="text-xs text-emerald-400 font-mono">준비 완료</span>
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

            {/* Publish Button */}
            <div className="pt-2">
              <button
                type="button"
                onClick={handlePublish}
                disabled={isSaving}
                className="w-full py-4 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-base rounded-2xl shadow-xl shadow-emerald-600/30 flex items-center justify-center gap-2 transition disabled:opacity-50"
              >
                <Send className="w-5 h-5" />
                <span>{isSaving ? '데이터베이스 저장 중...' : '이 내용으로 즉시 발행하기'}</span>
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
