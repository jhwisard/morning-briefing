'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { 
  Newspaper, TrendingUp, Sparkles, Calendar, Lock, 
  CheckCircle2, AlertCircle, ArrowLeft, Send, RefreshCw, 
  FileText, SunMedium, Eye
} from 'lucide-react';
import Link from 'next/link';

// 관리자 접속 비밀번호 (원하시는 번호로 변경 가능)
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

  // 2. 텍스트 지능형 자동 파서 (뉴스 & 주식 브리핑 원본 포맷 완벽 지원)
  const handleAutoParse = () => {
    if (!rawText.trim()) {
      alert('붙여넣을 브리핑 본문 텍스트를 입력해 주세요.');
      return;
    }

    setIsParsing(true);
    const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
    
    // 자동 타이틀 생성
    const dParts = briefingDate.split('-');
    const defaultTitle = categoryType === 'news'
      ? `${dParts[0]}년 ${parseInt(dParts[1])}월 ${parseInt(dParts[2])}일 간추린 종합 뉴스`
      : `${dParts[0]}년 ${parseInt(dParts[1])}월 ${parseInt(dParts[2])}일 주식 & 글로벌 마켓 모닝 브리핑`;
    
    if (!title) setTitle(defaultTitle);

    const sections: BriefingSection[] = [];
    let currentSec: BriefingSection | null = null;
    const extractedHighlights: string[] = [];
    let extractedWeather = '';

    if (categoryType === 'news') {
      // 간추린 뉴스 파싱 ([카테고리명] / ◐ 본문 (출처: 언론사))
      lines.forEach((line) => {
        if (line.startsWith('[') && line.includes(']')) {
          const catName = line.replace(/[\[\]]/g, '').trim();
          if (catName.includes('날씨')) {
            currentSec = null;
          } else {
            const secId = `sec_${sections.length + 1}`;
            currentSec = {
              id: secId,
              category: catName,
              icon: 'Globe',
              items: []
            };
            sections.push(currentSec);
          }
        } else if (line.startsWith('◐') || line.startsWith('⚬') || line.startsWith('-')) {
          let cleanLine = line.replace(/^[◐⚬\-*]\s*/, '').trim();
          
          // [날씨] 항목인 경우
          if (!currentSec && (line.includes('체감') || line.includes('기온') || line.includes('날씨') || line.includes('폭염') || line.includes('특보'))) {
            extractedWeather = cleanLine;
            return;
          }

          // 출처 추출 (출처: ...) 또는 (...)
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
      // 주식 모닝 브리핑 파싱 (1. 해외증시 / 2. 키워드 / 3. 주요뉴스 / 4. 시황)
      lines.forEach((line) => {
        if (/^[1-9]\.\s+/.test(line)) {
          const secTitle = line.trim();
          const secId = `sec_${sections.length + 1}`;
          currentSec = {
            id: secId,
            category: secTitle,
            icon: 'TrendingUp',
            items: []
          };
          sections.push(currentSec);
        } else if (line.startsWith('⚬') || line.startsWith('◐') || /^[1-9]\.\s*/.test(line) || line.startsWith('-')) {
          let cleanLine = line.replace(/^[◐⚬\-*]\s*/, '').replace(/^[1-9]\.\s*/, '').trim();
          
          let source = '증시 시황';
          const matchSource = cleanLine.match(/\((?:출처:\s*)?([^)]+)\)$/);
          if (matchSource) {
            source = matchSource[1].replace(/^출처:\s*/, '').trim();
            cleanLine = cleanLine.replace(/\((?:출처:\s*)?([^)]+)\)$/, '').trim();
          }

          if (currentSec) {
            currentSec.items.push({ text: cleanLine, source });
            if (currentSec.category.includes('키워드') && extractedHighlights.length < 3) {
              extractedHighlights.push(cleanLine);
            }
          }
        }
      });
    }

    setParsedSections(sections);
    if (extractedWeather && !weather) setWeather(extractedWeather);
    if (extractedHighlights.length > 0 && !highlightsText) {
      setHighlightsText(extractedHighlights.join('\n'));
    }

    setIsParsing(false);
    setStatusMsg({ type: 'success', text: `총 ${sections.length}개 섹션 데이터가 정상 파싱되었습니다. 내용을 검토 후 [발행하기]를 눌러주세요.` });
  };

  // 3. Supabase DB에 최종 발행 (Upsert)
  const handlePublish = async () => {
    if (!briefingDate || !title) {
      alert('날짜와 제목을 입력해 주세요.');
      return;
    }
    if (parsedSections.length === 0) {
      alert('파싱된 섹션 데이터가 없습니다. 먼저 [본문 자동 파싱]을 실행해 주세요.');
      return;
    }

    setIsSaving(true);
    setStatusMsg(null);

    const highlights = highlightsText
      .split('\n')
      .map(h => h.trim())
      .filter(Boolean);

    try {
      // 기존 해당 날짜/카테고리 레코드 덮어쓰기
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

      setStatusMsg({ type: 'success', text: `🎉 [${briefingDate}] ${categoryType === 'news' ? '간추린 뉴스' : '주식 브리핑'} 발행이 완료되었습니다!` });
    } catch (err: any) {
      console.error(err);
      setStatusMsg({ type: 'error', text: `발행 실패: ${err.message || '데이터베이스 오류'}` });
    } finally {
      setIsSaving(false);
    }
  };

  // 로그인 화면
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900 px-4">
        <div className="w-full max-w-sm bg-slate-800 border border-slate-700 rounded-2xl p-6 shadow-2xl space-y-5">
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
              placeholder="관리자 비밀번호 입력"
              className="w-full px-4 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
              autoFocus
            />
            {authError && (
              <p className="text-xs text-rose-400 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" /> 비밀번호가 일치하지 않습니다.
              </p>
            )}
            <button
              type="submit"
              className="w-full py-2.5 bg-sky-600 hover:bg-sky-500 text-white font-bold rounded-xl text-sm transition"
            >
              접속하기
            </button>
          </form>
          <div className="text-center">
            <Link href="/" className="text-xs text-slate-400 hover:text-slate-200">
              ← 사용자 화면으로 돌아가기
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans pb-20 antialiased">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href="/" className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <h1 className="text-base font-bold text-white flex items-center gap-2">
              <FileText className="w-5 h-5 text-sky-400" />
              브리핑 원클릭 자동 발행기
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
        
        {/* Status Toast Notification */}
        {statusMsg && (
          <div className={`p-4 rounded-xl text-xs sm:text-sm font-semibold flex items-center gap-2.5 shadow-lg ${
            statusMsg.type === 'success' ? 'bg-emerald-950/80 border border-emerald-500/50 text-emerald-300' : 'bg-rose-950/80 border border-rose-500/50 text-rose-300'
          }`}>
            {statusMsg.type === 'success' ? <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" /> : <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />}
            <span>{statusMsg.text}</span>
          </div>
        )}

        {/* Form Grid */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            
            {/* Category Select */}
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1.5">카테고리 선택</label>
              <div className="grid grid-cols-2 gap-2 p-1 bg-slate-950 rounded-xl border border-slate-800">
                <button
                  type="button"
                  onClick={() => setCategoryType('news')}
                  className={`py-2 text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 transition ${
                    categoryType === 'news' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <Newspaper className="w-4 h-4" /> 간추린 뉴스
                </button>
                <button
                  type="button"
                  onClick={() => setCategoryType('stock')}
                  className={`py-2 text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 transition ${
                    categoryType === 'stock' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <TrendingUp className="w-4 h-4" /> 주식 모닝 브리핑
                </button>
              </div>
            </div>

            {/* Date Picker */}
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1.5">발행 날짜 (YYYY-MM-DD)</label>
              <div className="relative">
                <Calendar className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="date"
                  value={briefingDate}
                  onChange={(e) => setBriefingDate(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500"
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
              className="w-full px-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500 placeholder-slate-600"
            />
          </div>

          {/* Weather / Subtitle Input */}
          <div>
            <label className="block text-xs font-bold text-slate-400 mb-1.5">날씨 또는 마켓 한줄 요약</label>
            <div className="relative">
              <SunMedium className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-amber-400" />
              <input
                type="text"
                value={weather}
                onChange={(e) => setWeather(e.target.value)}
                placeholder="예: 전국 대부분 체감 33~35°C 폭염특보 지속 ☀️ (출처: 기상청)"
                className="w-full pl-10 pr-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500 placeholder-slate-600"
              />
            </div>
          </div>

          {/* Highlights 3 Lines */}
          <div>
            <label className="block text-xs font-bold text-slate-400 mb-1.5">
              핵심 3줄 요약 (줄바꿈으로 구분)
            </label>
            <textarea
              rows={3}
              value={highlightsText}
              onChange={(e) => setHighlightsText(e.target.value)}
              placeholder="1. 첫 번째 핵심 키워드&#10;2. 두 번째 핵심 키워드&#10;3. 세 번째 핵심 키워드"
              className="w-full px-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs sm:text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500 placeholder-slate-600 leading-relaxed"
            />
          </div>

          {/* Raw Text Box */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-sky-400" />
                카톡/메신저 원본 텍스트 붙여넣기
              </label>
              <button
                type="button"
                onClick={handleAutoParse}
                disabled={isParsing}
                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg text-xs flex items-center gap-1.5 shadow-md shadow-indigo-600/30 transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isParsing ? 'animate-spin' : ''}`} />
                자동 파싱 실행
              </button>
            </div>
            <textarea
              rows={12}
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder={`여기에 아침 뉴스나 주식 브리핑 텍스트를 그대로 복사해서 붙여넣으세요.\n\n[예시 - 뉴스]\n[美미국]\n◐ 트럼프 행정부, 한미 연합훈련 축소 검토. (출처: 워싱턴포스트)\n\n[예시 - 주식]\n1. 해외 증시 마감 현황\n⚬ 다우 지수: 53,810.15 (+0.14%)`}
              className="w-full p-4 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-slate-300 focus:outline-none focus:ring-2 focus:ring-sky-500 placeholder-slate-700 leading-relaxed"
            />
          </div>
        </div>

        {/* Parsed Preview Area */}
        {parsedSections.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                파싱된 구조 미리보기 ({parsedSections.length}개 섹션)
              </h2>
              <span className="text-xs text-emerald-400 font-mono">준비 완료</span>
            </div>

            <div className="space-y-3">
              {parsedSections.map((sec, idx) => (
                <div key={sec.id || idx} className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-2.5">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <span className="text-xs font-bold text-sky-400">{sec.category}</span>
                    <span className="text-[10px] text-slate-500 font-mono">{sec.items.length}개 항목</span>
                  </div>
                  <ul className="space-y-1.5">
                    {sec.items.map((item, itemIdx) => (
                      <li key={itemIdx} className="text-xs text-slate-300 flex items-start gap-2">
                        <span className="text-sky-500">◐</span>
                        <span className="flex-1">{item.text}</span>
                        <span className="text-[10px] text-slate-500 shrink-0">[{item.source}]</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            {/* Final Publish Button */}
            <div className="pt-2">
              <button
                type="button"
                onClick={handlePublish}
                disabled={isSaving}
                className="w-full py-4 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-base rounded-2xl shadow-xl shadow-emerald-600/20 flex items-center justify-center gap-2 transition disabled:opacity-50"
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
