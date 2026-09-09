"use client";

import { useState, useEffect } from "react";

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [showButton, setShowButton] = useState(false);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event) => {
      // 브라우저 기본 팝업을 막고 이벤트 저장
      e.preventDefault();
      setDeferredPrompt(e);
      setShowButton(true); // 설치 버튼 노출
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;

    // 브라우저 설치 프롬프트 띄우기
    deferredPrompt.prompt();

    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      console.log("사용자가 PWA 설치를 수락함");
    } else {
      console.log("사용자가 PWA 설치를 거부함");
    }

    setDeferredPrompt(null);
    setShowButton(false);
  };

  if (!showButton) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 bg-indigo-900 text-white p-4 rounded-xl shadow-2xl flex items-center justify-between border border-indigo-500">
      <div>
        <p className="font-bold text-sm">모닝 브리핑 전용 앱 설치</p>
        <p className="text-xs text-indigo-200">바탕화면에 추가하고 1초만에 접속하세요!</p>
      </div>
      <button
        onClick={handleInstallClick}
        className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-bold shadow"
      >
        앱 설치하기
      </button>
    </div>
  );
}