'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { Briefing, BriefingSection } from '@/types/briefing';
import { 
  Newspaper, Sun, Moon, Search, X, Volume2, 
  Headphones, Play, Square, ListMusic, Sparkles, 
  Bookmark, SunMedium, Share2, CheckCircle2 
} from 'lucide-react';

export default function BriefingPage() {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentCategory, setCurrentCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLargeFont, setIsLargeFont] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [ttsState, setTtsState] = useState<'stopped' | 'highlights' | 'all' | 'section'>('stopped');

  // Supabase에서 가장 최신 날짜의 브리핑 데이터 1건 가져오기
  useEffect(() => {
    async function fetchLatestBriefing() {
      setLoading(true);
      const { data, error } = await supabase
        .from('briefings')
        .select('*')
        .order('briefing_date', { ascending: false })
        .limit(1)
        .single();

      if (error) {
        console.error('Error fetching briefing:', error);
      } else {
        setBriefing(data);
      }
      setLoading(false);
    }
    fetchLatestBriefing();
  }, []);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2000);
  };

  const stopTTS = () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setTtsState('stopped');
  };

  const speakText = (text: string, onEnd?: () => void) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      alert('음성 읽기를 지원하지 않는 브라우저입니다.');
      return;
    }
    stopTTS();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 1.05;
    utterance.onend = () => {
      stopTTS();
      if (onEnd) onEnd();
    };
    utterance.onerror = () => stopTTS();
    window.speechSynthesis.speak(utterance);
  };

  const toggleHighlightsTTS = () => {
    if (ttsState === 'highlights') {
      stopTTS();
      return;
    }
    if (!briefing) return;
    setTtsState('highlights');
    const text = `${briefing.briefing_date} 브리핑 핵심 요약입니다. ${briefing.highlights.join('. ')}`;
    speakText(text);
  };

  const toggleAllTTS = () => {
    if (ttsState === 'all') {
      stopTTS();
      return;
    }
    if (!briefing) return;
    setTtsState('all');
    let script = `${briefing.title}. 전체 브리핑을 시작합니다. `;
    briefing.sections.forEach((sec) => {
      script += `${sec.category} 소식입니다. `;
      sec.items.forEach((item) => {
        script += `${item.text}. `;
      });
    });
    speakText(script);
  };

  const readSectionTTS = (sec: BriefingSection) => {
    setTtsState('section');
    const script = `${sec.category} 브리핑입니다. ` + sec.items.map((i) => i.text).join('. ');
    speakText(script);
  };

  const copyBriefing = () => {
    if (!briefing) return;
    let fullText = `📰 ${briefing.title}\n\n`;
    briefing.sections.forEach((sec) => {
      fullText += `[${sec.category}]\n`;
      sec.items.forEach((item) => {
        fullText += `◐ ${item.text} (${item.source})\n`;
      });
      fullText += '\n';
    });
    navigator.clipboard.writeText(fullText);
    showToast('전체 브리핑이 복사되었습니다.');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-slate-500 text-sm">
        브리핑 데이터를 불러오는 중...
      </div>
    );
  }

  if (!briefing) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-slate-500 text-sm">
        등록된 브리핑이 없습니다. DB에 데이터를 추가해 주세요.
      </div>
    );
  }

  const filteredSections = briefing.sections.filter((sec) => {
    if (currentCategory !== 'all' && sec.id !== currentCategory) return false;
    if (!searchQuery) return true;
    const matchesCategory = sec.category.toLowerCase().includes(searchQuery.toLowerCase());
    const hasItem = sec.items.some(
      (item) =>
        item.text.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.source.toLowerCase().includes(searchQuery.toLowerCase())
    );
    return matchesCategory || hasItem;
  });

  return (
    <div className={isDark ? 'dark' : ''}>
      <div className="bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-100 min-h-screen transition-colors duration-200 antialiased font-sans pb-16">
        
        {/* 상단 헤더 */}
        <header className="sticky top-0 z-40 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 shadow-sm">
          <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center text-white shadow-md shadow-sky-500/20">
                <Newspaper className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.2 bg-sky-100 dark:bg-sky-950 text-sky-700 dark:text-sky-300 rounded">
                    Daily Brief
                  </span>
                  <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                    {briefing.briefing_date}
                  </span>
                </div>
                <h1 className="text-base font-bold text-slate-900 dark:text-white leading-tight">
                  {briefing.title}
                </h1>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  setIsLargeFont(!isLargeFont);
                  showToast(isLargeFont ? '기본 글씨 모드' : '큰 글씨 모드');
                }}
                title="글자 크기 조절"
                className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition text-xs font-bold flex items-center"
              >
                <span className="text-sm">가</span>
                <span className="text-[10px] text-slate-400">±</span>
              </button>
              <button
                onClick={copyBriefing}
                title="전체 복사"
                className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition"
              >
                <Share2 className="w-4 h-4" />
              </button>
              <button
                onClick={() => setIsDark(!isDark)}
                title="다크 모드 전환"
                className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition"
              >
                {isDark ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {briefing.weather && (
            <div className="max-w-2xl mx-auto px-4 pb-2.5 pt-0">
              <div className="flex items-center gap-1.5 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 px-2.5 py-1 rounded-full border border-amber-200/60 dark:border-amber-900/50 text-xs">
                <SunMedium className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                <span className="font-medium truncate">{briefing.weather}</span>
              </div>
            </div>
          )}
        </header>

        {/* 본문 콘텐츠 */}
        <main className="max-w-2xl mx-auto px-4 pt-4 space-y-4">
          {/* 검색 바 */}
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="키워드 검색 (예: 반도체, 트럼프, 삼성...)"
              className="w-full pl-10 pr-9 py-2.5 text-xs sm:text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-500 transition placeholder-slate-400 dark:placeholder-slate-500"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* 카테고리 필터 탭 */}
          <nav className="flex gap-1.5 overflow-x-auto py-1 no-scrollbar text-xs font-medium">
            <button
              onClick={() => setCurrentCategory('all')}
              className={`px-3 py-1.5 rounded-full transition whitespace-nowrap ${
                currentCategory === 'all'
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-bold'
                  : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800'
              }`}
            >
              전체 보기
            </button>
            {briefing.sections.map((sec) => (
              <button
                key={sec.id}
                onClick={() => setCurrentCategory(sec.id)}
                className={`px-3 py-1.5 rounded-full transition whitespace-nowrap ${
                  currentCategory === sec.id
                    ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-bold'
                    : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800'
                }`}
              >
                {sec.category}
              </button>
            ))}
          </nav>

          {/* TTS 오디오 플레이어 */}
          <section className="bg-gradient-to-r from-sky-600 to-indigo-700 text-white rounded-2xl p-4 shadow-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/15 backdrop-blur-md flex items-center justify-center shrink-0">
                <Headphones className="w-5 h-5" />
              </div>
              <div>
                <div className="text-[11px] font-medium text-sky-200 flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                  출근길 오디오 브리핑
                </div>
                <p className="text-xs sm:text-sm font-bold text-white leading-tight">
                  {ttsState !== 'stopped' ? '음성 브리핑 재생 중...' : '오늘의 핵심 3대 헤드라인 듣기'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={toggleHighlightsTTS}
                className="flex-1 sm:flex-initial px-3.5 py-2 rounded-xl bg-white text-sky-800 hover:bg-sky-50 font-bold text-xs flex items-center justify-center gap-1.5 transition"
              >
                {ttsState === 'highlights' ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                <span>{ttsState === 'highlights' ? '정지' : '요약 재생'}</span>
              </button>
              <button
                onClick={toggleAllTTS}
                className="flex-1 sm:flex-initial px-3.5 py-2 rounded-xl bg-sky-800/80 hover:bg-sky-900 text-white font-medium text-xs flex items-center justify-center gap-1.5 border border-sky-400/30 transition"
              >
                {ttsState === 'all' ? <Square className="w-3.5 h-3.5" /> : <ListMusic className="w-3.5 h-3.5" />}
                <span>{ttsState === 'all' ? '정지' : '전체 듣기'}</span>
              </button>
            </div>
          </section>

          {/* 3줄 요약 카드 */}
          {briefing.highlights && briefing.highlights.length > 0 && (
            <section className="bg-sky-50/60 dark:bg-sky-950/30 border border-sky-200/70 dark:border-sky-800/60 rounded-2xl p-4 shadow-sm space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-bold text-sky-700 dark:text-sky-300">
                  <Sparkles className="w-4 h-4 text-amber-500" />
                  오늘의 핵심 키워드 3줄 요약
                </div>
                <span className="text-[10px] text-slate-400 font-mono">08/17 07:00 KST</span>
              </div>
              <ul className="text-xs sm:text-sm leading-relaxed text-slate-700 dark:text-slate-200 space-y-1.5 list-disc list-inside">
                {briefing.highlights.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            </section>
          )}

          {/* 뉴스 섹션 카드 리스트 */}
          <div className="space-y-3.5">
            {filteredSections.map((sec) => (
              <section
                key={sec.id}
                className="bg-white dark:bg-slate-900 rounded-2xl p-4 sm:p-5 shadow-sm border border-slate-200/80 dark:border-slate-800 space-y-3"
              >
                <div className="flex items-center justify-between pb-2.5 border-b border-slate-100 dark:border-slate-800/80">
                  <div className="flex items-center gap-2">
                    <h2 className="font-bold text-sm sm:text-base text-slate-900 dark:text-slate-100">
                      {sec.category}
                    </h2>
                    <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">
                      {sec.items.length}건
                    </span>
                  </div>
                  <button
                    onClick={() => readSectionTTS(sec)}
                    title="이 섹션만 읽기"
                    className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-sky-600 transition"
                  >
                    <Volume2 className="w-4 h-4" />
                  </button>
                </div>

                <ul className="space-y-3">
                  {sec.items.map((item, itemIdx) => (
                    <li key={itemIdx} className="flex items-start gap-2 group">
                      <span className="text-sky-500 dark:text-sky-400 font-bold select-none text-xs sm:text-sm mt-0.5">◐</span>
                      <div className="flex-1 space-y-1">
                        <p className={`text-slate-800 dark:text-slate-200 leading-snug ${isLargeFont ? 'text-sm sm:text-base' : 'text-xs sm:text-sm'}`}>
                          {item.text}
                        </p>
                        <div className="flex items-center gap-2 text-[10px] text-slate-400 dark:text-slate-500">
                          <span className="inline-flex items-center gap-1">
                            <Bookmark className="w-3 h-3" /> {item.source}
                          </span>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(item.text);
                              showToast('항목이 복사되었습니다.');
                            }}
                            className="opacity-0 group-hover:opacity-100 hover:text-slate-600 dark:hover:text-slate-300 transition text-[10px]"
                          >
                            복사
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </main>

        {/* 토스트 알림 */}
        {toastMsg && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-xl bg-slate-900/90 text-white text-xs font-semibold shadow-xl border border-slate-700 backdrop-blur-md z-50 flex items-center gap-2 animate-fade-in">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>{toastMsg}</span>
          </div>
        )}
      </div>
    </div>
  );
}
