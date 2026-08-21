'use client';

import { useState, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { 
  Newspaper, TrendingUp, Lightbulb, Sun, Moon, Search, X, Volume2, 
  Headphones, Play, Square, ListMusic, Sparkles, 
  Bookmark, SunMedium, Share2, CheckCircle2,
  Calendar, ChevronLeft, ChevronRight, Users, Quote, Compass
} from 'lucide-react';

export interface NewsItem {
  text: string;
  source: string;
}

export interface BriefingSection {
  id: string;
  category: string;
  icon: string;
  items: NewsItem[];
}

export interface Briefing {
  id: string;
  briefing_date: string;
  category_type: string;
  title: string;
  weather: string | null;
  insight?: string | null;
  highlights: string[];
  sections: BriefingSection[];
  created_at: string;
}

type TTSStatus = {
  type: 'stopped' | 'highlights' | 'all' | 'section';
  targetId?: string;
};

export default function BriefingPage() {
  const [mainTab, setMainTab] = useState<'news' | 'stock' | 'insight'>('news');
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [briefing, setBriefing] = useState<Briefing null |>(null);
  const [loading, setLoading] = useState(true);
  const [currentCategory, setCurrentCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLargeFont, setIsLargeFont] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // 통합 배타적 TTS 상태 및 발화체 추적 Ref
  const [ttsState, setTtsState] = useState<TTSStatus>({ type: 'stopped' });
  const currentUtteranceRef = useRef<SpeechSynthesisUtterance null |>(null);
  
  // 방문자 카운트 통계 상태
  const [visitorStats, setVisitorStats] = useState<{ today: number; total: number } | null>(null);

  // 날짜 가로 스크롤 컨테이너 Ref
  const dateScrollRef = useRef<HTMLDivElement>(null);

  // 1. 모바일 브라우저 음성 목록 사전 로드
  useEffect(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
      };
    }
  }, []);

  // 2. 방문자 카운터 집계 (세션 기반 중복 방지)
  useEffect(() => {
    async function recordVisit() {
      try {
        const hasVisitedSession = sessionStorage.getItem('visited_today');
        if (!hasVisitedSession) {
          const { data, error } = await supabase.rpc('increment_visitor_count');
          if (!error && data) {
            setVisitorStats(data);
            sessionStorage.setItem('visited_today', 'true');
          }
        } else {
          const { data: todayRow } = await supabase
            .from('site_visits')
            .select('visit_count')
            .eq('visit_date', new Date().toISOString().split('T')[0])
            .single();
          
          const { data: totalRows } = await supabase
            .from('site_visits')
            .select('visit_count');

          const today = todayRow?.visit_count || 0;
          const total = totalRows?.reduce((acc, cur) => acc + (cur.visit_count || 0), 0) || 0;
          setVisitorStats({ today, total });
        }
      } catch (err) {
        console.error('방문자 카운트 로드 실패:', err);
      }
    }
    recordVisit();
  }, []);

  // 3. 날짜 가로 스크롤 자동 포커싱
  useEffect(() => {
    if (dateScrollRef.current) {
      const selectedBtn = dateScrollRef.current.querySelector<HTMLElement>('[data-selected="true"]');
      if (selectedBtn) {
        selectedBtn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    }
  }, [selectedDate, availableDates]);

  // 4. 탭 변경 시 날짜 목록 불러오기
  useEffect(() => {
    async function loadDatesForTab() {
      setLoading(true);
      stopTTS();
      
      const { data: dateRows, error: dateError } = await supabase
        .from('briefings')
        .select('briefing_date')
        .eq('category_type', mainTab)
        .order('briefing_date', { ascending: true });

      if (dateError || !dateRows || dateRows.length === 0) {
        setAvailableDates([]);
        setBriefing(null);
        setLoading(false);
        return;
      }

      const uniqueDates = Array.from(new Set(dateRows.map(r => r.briefing_date)));
      setAvailableDates(uniqueDates);

      const latestDate = uniqueDates[uniqueDates.length - 1];
      setSelectedDate(latestDate);
      await fetchBriefing(mainTab, latestDate);
    }
    loadDatesForTab();
  }, [mainTab]);

  async function fetchBriefing(tab: 'news' | 'stock' | 'insight', dateStr: string) {
    setLoading(true);
    stopTTS();
    const { data, error } = await supabase
      .from('briefings')
      .select('*')
      .eq('category_type', tab)
      .eq('briefing_date', dateStr)
      .single();

    if (error) {
      console.error('Error fetching briefing:', error);
      setBriefing(null);
    } else {
      setBriefing(data as Briefing);
      setCurrentCategory('all');
      setSearchQuery('');
    }
    setLoading(false);
  }

  const handleDateChange = (newDate: string) => {
    if (newDate === selectedDate || !newDate) return;
    setSelectedDate(newDate);
    fetchBriefing(mainTab, newDate);
  };

  const formatDateLabel = (dateStr: string) => {
    try {
      const parts = dateStr.split('-');
      const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      const days = ['일', '월', '화', '수', '목', '금', '토'];
      const dayName = days[d.getDay()];
      return `${parseInt(parts[1])}/${parseInt(parts[2])}(${dayName})`;
    } catch {
      return dateStr;
    }
  };

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2000);
  };

  // --- TTS 오디오 배타적 토글 제어 ---
  const getKoreanVoice = () => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    return (
      voices.find((v) => v.lang === 'ko-KR' || v.lang === 'ko_KR') ||
      voices.find((v) => v.lang.startsWith('ko')) ||
      voices.find((v) => v.name.toLowerCase().includes('korean') || v.name.includes('한국어')) ||
      null
    );
  };

  const stopTTS = () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      if (currentUtteranceRef.current) {
        currentUtteranceRef.current.onend = null;
        currentUtteranceRef.current.onerror = null;
        currentUtteranceRef.current = null;
      }
      window.speechSynthesis.cancel();
    }
    setTtsState({ type: 'stopped' });
  };

  const speakText = (text: string, newStatus: TTSStatus) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      alert('음성 읽기를 지원하지 않는 브라우저입니다.');
      return;
    }
    stopTTS();
    window.speechSynthesis.resume();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    const koVoice = getKoreanVoice();
    if (koVoice) {
      utterance.voice = koVoice;
    }
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    currentUtteranceRef.current = utterance;

    utterance.onend = () => {
      if (currentUtteranceRef.current === utterance) {
        currentUtteranceRef.current = null;
        setTtsState({ type: 'stopped' });
      }
    };
    utterance.onerror = () => {
      if (currentUtteranceRef.current === utterance) {
        currentUtteranceRef.current = null;
        setTtsState({ type: 'stopped' });
      }
    };

    setTtsState(newStatus);
    window.speechSynthesis.speak(utterance);
  };

  const toggleHighlightsTTS = () => {
    if (ttsState.type === 'highlights') {
      stopTTS();
      return;
    }
    if (!briefing) return;
    const tabName = mainTab === 'stock' ? '주식' : mainTab === 'insight' ? '데일리 인사이트' : '간추린';
    const text = `${formatDateLabel(briefing.briefing_date)} ${tabName} 브리핑 요약입니다. ${briefing.highlights.join('. ')}`;
    speakText(text, { type: 'highlights' });
  };

  const toggleAllTTS = () => {
    if (ttsState.type === 'all') {
      stopTTS();
      return;
    }
    if (!briefing) return;
    let script = `${briefing.title}. 전체 브리핑을 시작합니다. `;
    briefing.sections.forEach((sec: BriefingSection) => {
      script += `${sec.category} 내용입니다. `;
      sec.items.forEach((item: NewsItem) => {
        script += `${item.text}. `;
      });
    });
    speakText(script, { type: 'all' });
  };

  const toggleSectionTTS = (sec: BriefingSection) => {
    if (ttsState.type === 'section' && ttsState.targetId === sec.id) {
      stopTTS();
      return;
    }
    const script = `${sec.category} 내용입니다. ` + sec.items.map((i: NewsItem) => i.text).join('. ');
    speakText(script, { type: 'section', targetId: sec.id });
  };

  const copyBriefing = () => {
    if (!briefing) return;
    let fullText = `📰 ${briefing.title}\n\n`;
    briefing.sections.forEach((sec: BriefingSection) => {
      fullText += `[${sec.category}]\n`;
      sec.items.forEach((item: NewsItem) => {
        fullText += `◐ ${item.text} (${item.source})\n`;
      });
      fullText += '\n';
    });
    navigator.clipboard.writeText(fullText);
    showToast('전체 브리핑이 복사되었습니다.');
  };

  const currentIndex = availableDates.indexOf(selectedDate);

  const filteredSections = briefing ? briefing.sections.filter((sec: BriefingSection) => {
    if (currentCategory !== 'all' && sec.id !== currentCategory) return false;
    if (!searchQuery) return true;
    const matchesCategory = sec.category.toLowerCase().includes(searchQuery.toLowerCase());
    const hasItem = sec.items.some(
      (item: NewsItem) =>
        item.text.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.source.toLowerCase().includes(searchQuery.toLowerCase())
    );
    return matchesCategory || hasItem;
  }) : [];

  return (
    <div className={isDark ? 'dark' : ''}>
      <div className="bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-100 min-h-screen transition-colors duration-200 antialiased font-sans pb-16">
        
        {/* Sticky Header */}
        <header className="sticky top-0 z-50 transform-gpu bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 shadow-sm pt-[env(safe-area-inset-top,0px)] transition-colors">
          <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-white shadow-md ${
                mainTab === 'stock' 
                  ? 'bg-gradient-to-tr from-emerald-500 to-teal-600 shadow-emerald-500/20' 
                  : mainTab === 'insight'
                  ? 'bg-gradient-to-tr from-amber-500 to-orange-600 shadow-amber-500/20'
                  : 'bg-gradient-to-tr from-sky-500 to-indigo-600 shadow-sky-500/20'
              }`}>
                {mainTab === 'stock' ? (
                  <TrendingUp className="w-5 h-5"/>
                ) : mainTab === 'insight' ? (
                  <Lightbulb className="w-5 h-5"/>
                ) : (
                  <Newspaper className="w-5 h-5"/>
                )}
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className={`text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.2 rounded ${
                    mainTab === 'stock'
                      ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300'
                      : mainTab === 'insight'
                      ? 'bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300'
                      : 'bg-sky-100 dark:bg-sky-950 text-sky-700 dark:text-sky-300'
                  }`}>
                    {mainTab === 'stock' ? 'Stock Brief' : mainTab === 'insight' ? 'Daily Insight' : 'News Brief'}
                  </span>
                  <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                    {briefing ? briefing.briefing_date : selectedDate}
                  </span>
                </div>
                <h1 className="text-base font-bold text-slate-900 dark:text-white leading-tight">
                  {mainTab === 'stock' ? '주식 모닝 브리핑' : mainTab === 'insight' ? '데일리 인사이트' : '간추린 뉴스'}
                </h1>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  setIsLargeFont(!isLargeFont);
                  showToast(isLargeFont ? '기본 글씨 모드' : '큰 글씨 모드');
                }}
                className={`p-2 rounded-lg transition text-xs font-bold flex items-center ${
                  isLargeFont 
                    ? 'bg-sky-600 text-white dark:bg-sky-500' 
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
                title="글씨 크기 조절"
              >
                <span className="text-sm">가</span>
                <span className="text-[10px] opacity-80">±</span>
              </button>
              <button
                onClick={copyBriefing}
                className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition"
                title="전체 복사"
              >
                <Share2 className="w-4 h-4"/>
              </button>
              <button
                onClick={() => setIsDark(!isDark)}
                className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition"
                title="다크 모드 전환"
              >
                {isDark ? <Sun className="w-4 h-4 text-amber-400"/> : <Moon className="w-4 h-4 text-slate-600"/>}
              </button>
            </div>
          </div>

          {/* Main 3-Segment Tab Switcher */}
          <div className="max-w-2xl mx-auto px-4 pb-2.5">
            <div className="grid grid-cols-3 p-1 bg-slate-100 dark:bg-slate-800/80 rounded-xl border border-slate-200 dark:border-slate-700/60">
              <button
                onClick={() => setMainTab('news')}
                className={`py-1.5 text-xs font-bold rounded-lg flex items-center justify-center gap-1 transition ${
                  mainTab === 'news'
                    ? 'bg-white dark:bg-slate-900 text-sky-600 dark:text-sky-400 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                <Newspaper className="w-3.5 h-3.5"/>
                <span>간추린 뉴스</span>
              </button>
              <button
                onClick={() => setMainTab('stock')}
                className={`py-1.5 text-xs font-bold rounded-lg flex items-center justify-center gap-1 transition ${
                  mainTab === 'stock'
                    ? 'bg-white dark:bg-slate-900 text-emerald-600 dark:text-emerald-400 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                <TrendingUp className="w-3.5 h-3.5"/>
                <span>주식 브리핑</span>
              </button>
              <button
                onClick={() => setMainTab('insight')}
                className={`py-1.5 text-xs font-bold rounded-lg flex items-center justify-center gap-1 transition ${
                  mainTab === 'insight'
                    ? 'bg-white dark:bg-slate-900 text-amber-600 dark:text-amber-400 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                <Lightbulb className="w-3.5 h-3.5"/>
                <span>데일리 인사이트</span>
              </button>
            </div>
          </div>

          {/* Weather / Subtitle Banner */}
          {briefing?.weather && (
            <div className="max-w-2xl mx-auto px-4 pb-2.5 pt-0">
              <div className="flex items-center gap-1.5 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 px-2.5 py-1 rounded-full border border-amber-200/60 dark:border-amber-900/50 text-xs">
                <SunMedium className="w-3.5 h-3.5 text-amber-500 shrink-0"/>
                <span className="font-medium truncate">{briefing.weather}</span>
              </div>
            </div>
          )}
        </header>

        <main className="max-w-2xl mx-auto px-4 pt-4 space-y-4">
          
          {/* Date Navigator */}
          {availableDates.length > 0 && (
            <div className="flex items-center justify-between bg-white dark:bg-slate-900 px-2 py-1.5 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-sm">
              <button
                onClick={() => handleDateChange(availableDates[currentIndex - 1])}
                disabled={currentIndex <= 0}
                className="p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 disabled:opacity-20 disabled:cursor-not-allowed transition"
                title="이전 날짜"
              >
                <ChevronLeft className="w-4 h-4"/>
              </button>

              <div 
                ref={dateScrollRef} 
                className="flex gap-1.5 overflow-x-auto no-scrollbar py-0.5 scroll-smooth"
              >
                {availableDates.map((dStr, idx) => {
                  const isSelected = dStr === selectedDate;
                  const isLatest = idx === availableDates.length - 1;
                  return (
                    <button
                      key={dStr}
                      data-selected={isSelected}
                      onClick={() => handleDateChange(dStr)}
                      className={`px-3 py-1 rounded-xl text-xs font-semibold transition flex items-center gap-1.5 shrink-0 ${
                        isSelected
                          ? mainTab === 'stock'
                            ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-600/30'
                            : mainTab === 'insight'
                            ? 'bg-amber-600 text-white shadow-sm shadow-amber-600/30'
                            : 'bg-sky-600 text-white shadow-sm shadow-sky-600/30'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                      }`}
                    >
                      <Calendar className="w-3 h-3"/>
                      <span>{formatDateLabel(dStr)}</span>
                      {isLatest && (
                        <span className={`text-[9px] px-1 py-0.2 rounded font-bold ${
                          isSelected 
                            ? 'bg-white/20 text-white' 
                            : mainTab === 'stock' 
                              ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300' 
                              : mainTab === 'insight'
                              ? 'bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300'
                              : 'bg-sky-100 dark:bg-sky-950 text-sky-700 dark:text-sky-300'
                        }`}>
                          최신
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <button
                onClick={() => handleDateChange(availableDates[currentIndex + 1])}
                disabled={currentIndex >= availableDates.length - 1}
                className="p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 disabled:opacity-20 disabled:cursor-not-allowed transition"
                title="다음 날짜"
              >
                <ChevronRight className="w-4 h-4"/>
              </button>
            </div>
          )}

          {/* Search Bar */}
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"/>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                mainTab === 'stock' 
                  ? "종목/테마/지수 검색 (예: 반도체, 엔비디아, 코스피...)" 
                  : mainTab === 'insight'
                  ? "인사이트 키워드 검색 (예: 마인드셋, 실행력, 자존감...)"
                  : "키워드 검색 (예: 정책, 글로벌 이슈, 경제...)"
              }
              className="w-full pl-10 pr-9 py-2.5 text-xs sm:text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-500 transition placeholder-slate-400 dark:placeholder-slate-500"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4"/>
              </button>
            )}
          </div>

          {loading ? (
            <div className="py-16 text-center text-slate-400 text-xs">
              브리핑 데이터를 불러오는 중...
            </div>
          ) : !briefing ? (
            <div className="py-16 text-center text-slate-400 text-xs bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800">
              해당 날짜에 등록된 브리핑이 없습니다.
            </div>
          ) : (
            <>
              {/* Category Sub-tabs */}
              <nav className="flex gap-1.5 overflow-x-auto py-1 no-scrollbar text-xs font-medium">
                <button
                  onClick={() => setCurrentCategory('all')}
                  className={`px-3 py-1.5 rounded-full transition whitespace-nowrap ${
                    currentCategory === 'all'
                      ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-bold shadow-sm'
                      : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800'
                  }`}
                >
                  전체 보기
                </button>
                {briefing.sections.map((sec: BriefingSection) => (
                  <button
                    key={sec.id}
                    onClick={() => setCurrentCategory(sec.id)}
                    className={`px-3 py-1.5 rounded-full transition whitespace-nowrap ${
                      currentCategory === sec.id
                        ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-bold shadow-sm'
                        : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800'
                    }`}
                  >
                    {sec.category}
                  </button>
                ))}
              </nav>

              {/* Audio TTS Banner */}
              <section className={`text-white rounded-2xl p-4 shadow-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                mainTab === 'stock'
                  ? 'bg-gradient-to-r from-emerald-600 to-teal-700'
                  : mainTab === 'insight'
                  ? 'bg-gradient-to-r from-amber-600 to-orange-700'
                  : 'bg-gradient-to-r from-sky-600 to-indigo-700'
              }`}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-white/15 backdrop-blur-md flex items-center justify-center shrink-0">
                    <Headphones className="w-5 h-5"/>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium text-amber-100 flex items-center gap-1">
                      {ttsState.type !== 'stopped' && (
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-300 animate-ping" />
                      )}
                      {mainTab === 'stock' ? '모닝 증시 오디오 브리핑' : mainTab === 'insight' ? '데일리 사색 오디오 브리핑' : '출근길 오디오 브리핑'}
                    </div>
                    <p className="text-xs sm:text-sm font-bold text-white leading-tight">
                      {ttsState.type !== 'stopped' ? '음성 브리핑 재생 중...' : `${formatDateLabel(briefing.briefing_date)} 핵심 요약 듣기`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={toggleHighlightsTTS}
                    className="flex-1 sm:flex-initial px-3.5 py-2 rounded-xl bg-white text-slate-900 hover:bg-slate-50 font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-95"
                  >
                    {ttsState.type === 'highlights' ? <Square className="w-3.5 h-3.5 fill-current"/> : <Play className="w-3.5 h-3.5 fill-current"/>}
                    <span>{ttsState.type === 'highlights' ? '정지' : '요약 재생'}</span>
                  </button>
                  <button
                    onClick={toggleAllTTS}
                    className="flex-1 sm:flex-initial px-3.5 py-2 rounded-xl bg-black/20 hover:bg-black/30 text-white font-medium text-xs flex items-center justify-center gap-1.5 border border-white/20 transition active:scale-95"
                  >
                    {ttsState.type === 'all' ? <Square className="w-3.5 h-3.5 fill-current"/> : <ListMusic className="w-3.5 h-3.5"/>}
                    <span>{ttsState.type === 'all' ? '정지' : '전체 듣기'}</span>
                  </button>
                </div>
              </section>

              {/* Highlights 3 lines */}
              {briefing.highlights && briefing.highlights.length > 0 && (
                <section className={`border rounded-2xl p-4 shadow-sm space-y-2.5 ${
                  mainTab === 'stock'
                    ? 'bg-emerald-50/60 dark:bg-emerald-950/30 border-emerald-200/70 dark:border-emerald-800/60'
                    : mainTab === 'insight'
                    ? 'bg-amber-50/60 dark:bg-amber-950/30 border-amber-200/70 dark:border-amber-800/60'
                    : 'bg-sky-50/60 dark:bg-sky-950/30 border-sky-200/70 dark:border-sky-800/60'
                }`}>
                  <div className="flex items-center justify-between">
                    <div className={`flex items-center gap-1.5 text-xs font-bold ${
                      mainTab === 'stock' 
                        ? 'text-emerald-800 dark:text-emerald-300' 
                        : mainTab === 'insight'
                        ? 'text-amber-800 dark:text-amber-300'
                        : 'text-sky-700 dark:text-sky-300'
                    }`}>
                      <Sparkles className="w-4 h-4 text-amber-500"/>
                      {mainTab === 'stock' ? '오늘의 마켓 핵심 포인트 3줄 요약' : mainTab === 'insight' ? '오늘의 생각과 마인드셋 3줄 요약' : '오늘의 핵심 키워드 3줄 요약'}
                    </div>
                    <span className="text-[10px] text-slate-400 font-mono">{briefing.briefing_date}</span>
                  </div>
                  <ul className={`leading-relaxed text-slate-700 dark:text-slate-200 space-y-1.5 list-disc list-inside ${
                    isLargeFont ? 'text-sm sm:text-base' : 'text-xs sm:text-sm'
                  }`}>
                    {briefing.highlights.map((h: string, i: number) => (
                      <li key={i}>{h}</li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Sections List */}
              <div className="space-y-3.5">
                {filteredSections.map((sec: BriefingSection) => {
                  const isPlayingThis = ttsState.type === 'section' && ttsState.targetId === sec.id;
                  const isQuoteSection = sec.category.includes('생각의 원점') || sec.category.includes('1.');
                  const isPivotSection = sec.category.includes('마인드 피벗') || sec.category.includes('2.');

                  return (
                    <section
                      key={sec.id}
                      className={`rounded-2xl p-4 sm:p-5 shadow-sm border transition ${
                        mainTab === 'insight' && isQuoteSection
                          ? 'bg-gradient-to-br from-amber-50/70 to-orange-50/40 dark:from-amber-950/20 dark:to-slate-900 border-amber-200/80 dark:border-amber-800/60'
                          : mainTab === 'insight' && isPivotSection
                          ? 'bg-gradient-to-br from-emerald-50/70 to-teal-50/40 dark:from-emerald-950/20 dark:to-slate-900 border-emerald-200/80 dark:border-emerald-800/60'
                          : 'bg-white dark:bg-slate-900 border-slate-200/80 dark:border-slate-800'
                      } space-y-3`}
                    >
                      <div className="flex items-center justify-between pb-2.5 border-b border-slate-100 dark:border-slate-800/80">
                        <div className="flex items-center gap-2">
                          {mainTab === 'insight' && isQuoteSection ? (
                            <Quote className="w-4 h-4 text-amber-500"/>
                          ) : mainTab === 'insight' && isPivotSection ? (
                            <Compass className="w-4 h-4 text-emerald-500"/>
                          ) : null}
                          <h2 className="font-bold text-sm sm:text-base text-slate-900 dark:text-slate-100">
                            {sec.category}
                          </h2>
                          <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">
                            {sec.items.length}건
                          </span>
                        </div>

                        <button
                          onClick={() => toggleSectionTTS(sec)}
                          title={isPlayingThis ? "재생 중지" : "이 섹션만 듣기"}
                          className={`p-1.5 rounded-lg transition flex items-center gap-1 text-xs font-semibold ${
                            isPlayingThis
                              ? 'bg-amber-500 text-white animate-pulse'
                              : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
                          }`}
                        >
                          {isPlayingThis ? <Square className="w-4 h-4 fill-current"/> : <Volume2 className="w-4 h-4"/>}
                        </button>
                      </div>

                      <ul className="space-y-3">
                        {sec.items.map((item: NewsItem, itemIdx: number) => (
                          <li key={itemIdx} className="flex items-start gap-2 group">
                            <span className={`font-bold select-none text-xs sm:text-sm mt-0.5 ${
                              mainTab === 'stock' 
                                ? 'text-emerald-500' 
                                : mainTab === 'insight'
                                ? 'text-amber-500'
                                : 'text-sky-500'
                            }`}>
                              {mainTab === 'insight' && isQuoteSection ? '“' : '◐'}
                            </span>
                            <div className="flex-1 space-y-1">
                              <p className={`text-slate-800 dark:text-slate-200 leading-relaxed ${
                                isLargeFont ? 'text-sm sm:text-base' : 'text-xs sm:text-sm'
                              } ${mainTab === 'insight' && isQuoteSection ? 'italic font-medium' : ''}`}>
                                {item.text}
                              </p>
                              <div className="flex items-center gap-2 text-[10px] text-slate-400 dark:text-slate-500">
                                <span className="inline-flex items-center gap-1">
                                  <Bookmark className="w-3 h-3"/> {item.source}
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
                  );
                })}
              </div>
            </>
          )}
        </main>

        {/* 하단 방문자 카운터 (박스형 아웃라인) & 카피라이트 */}
        <footer className="max-w-2xl mx-auto px-4 mt-10 pt-6 pb-6 border-t border-slate-200/60 dark:border-slate-800/60 text-center">
          <div className="inline-flex items-center gap-2.5 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm text-xs text-slate-600 dark:text-slate-300 shadow-sm">
            <Users className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400"/>
            <span>오늘 <strong className="text-slate-900 dark:text-white font-bold">{visitorStats ? visitorStats.today.toLocaleString() : '-'}</strong></span>
            <span className="text-slate-300 dark:text-slate-700">•</span>
            <span>누적 <strong className="text-slate-900 dark:text-white font-bold">{visitorStats ? visitorStats.total.toLocaleString() : '-'}</strong></span>
          </div>
          <p className="text-[11px] text-slate-400 dark:text-slate-600 mt-3 font-light tracking-tight">
            © 2026 Morning Briefing. All rights reserved.
          </p>
        </footer>

        {toastMsg && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-xl bg-slate-900/90 text-white text-xs font-semibold shadow-xl border border-slate-700 backdrop-blur-md z-50 flex items-center gap-2 animate-fade-in">
            <CheckCircle2 className="w-4 h-4 text-emerald-400"/>
            <span>{toastMsg}</span>
          </div>
        )}
      </div>
    </div>
  );
}
