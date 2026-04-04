'use client';

import { useEffect, useRef } from 'react';
import bootCafe from './engine/boot';

/* ────────────────────────────────────────────
   Thinker Cafe — Cinematic Engine v2.0
   Architecture: 1 static image + CSS VFX + vanilla JS
   Zero React state. DOM-direct. ConcernedApe spirit.
   ──────────────────────────────────────────── */

export default function CafePage() {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    bootCafe();

    // Dust mote spawner — 5s after boot
    setTimeout(() => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const container = document.getElementById('dust-container');
      if (!container) return;

      function spawnDust() {
        container!.innerHTML = '';
        for (let i = 0; i < 10; i++) {
          const mote = document.createElement('div');
          mote.className = 'dust-mote';
          mote.style.left = `${20 + Math.random() * 60}%`;
          mote.style.top = `${30 + Math.random() * 50}%`;
          mote.style.width = mote.style.height = `${2 + Math.random() * 3}px`;
          mote.style.animationDuration = `${8 + Math.random() * 12}s`;
          mote.style.animationDelay = `${Math.random() * 5}s`;
          container!.appendChild(mote);
        }
      }
      spawnDust();
      setInterval(spawnDust, 20000);
    }, 5000);
  }, []);

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@300;400;500;700&display=swap"
        rel="stylesheet"
      />

      <style>{`
        html, body {
          margin: 0; padding: 0; width: 100%; height: 100%;
          background-color: #03070b; color: #fff;
          font-family: 'Noto Serif TC', serif;
          overflow: hidden; user-select: none;
          cursor: none;
        }
        .min-h-screen { background: #03070b !important; }

        /* ── Layer 0: Cinematic Base ── */
        #base-layer {
          position: absolute; inset: -15%;
          width: 130%; height: 130%;
          background-image: url('/cafe-game/cafe-portrait.jpg');
          background-size: cover; background-position: center 40%;
          z-index: 1;
          filter: blur(20px) brightness(0.2);
          transform: scale(1.6);
          transition: filter 2s ease, transform 5s cubic-bezier(0.25, 0.46, 0.45, 0.94);
        }
        #base-layer.awake {
          filter: blur(0px) brightness(1);
          transform: scale(1.04);
        }
        #base-layer.dimmed {
          filter: blur(4px) brightness(0.5);
          transform: scale(1.04);
        }
        /* Landscape screens: use landscape image */
        @media (min-aspect-ratio: 4/3) {
          #base-layer {
            background-image: url('/cafe-game/cafe-cinematic.jpg');
            background-position: center center;
          }
        }

        /* ── Person softener — defocus the barista so he's not staring ── */
        #person-blur {
          position: absolute;
          top: 12%; left: 25%; width: 50%; height: 40%;
          z-index: 2;
          backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
          mask-image: radial-gradient(ellipse 100% 100% at center, black 30%, transparent 80%);
          -webkit-mask-image: radial-gradient(ellipse 100% 100% at center, black 30%, transparent 80%);
          pointer-events: none;
          opacity: 0;
          transition: opacity 2s ease 5s;
        }
        #base-layer.awake ~ #person-blur { opacity: 1; }
        @media (min-aspect-ratio: 4/3) {
          #person-blur { top: 15%; left: 30%; width: 40%; height: 45%; }
        }

        /* ── Layer 1: Atmosphere ── */
        #ambient-light {
          position: absolute; top: 10%; right: 20%; width: 40%; height: 60%;
          background: radial-gradient(circle at center, rgba(255,214,153,0.12) 0%, transparent 60%);
          mix-blend-mode: screen; pointer-events: none; z-index: 2;
          animation: lightBreathe 6s ease-in-out infinite alternate;
        }
        @keyframes lightBreathe {
          0% { opacity: 0.6; transform: scale(0.95); }
          100% { opacity: 1; transform: scale(1.05); }
        }

        #window-light {
          position: absolute; top: 0; left: 0; width: 40%; height: 100%;
          background: linear-gradient(90deg, rgba(16,42,67,0.3) 0%, transparent 100%);
          mix-blend-mode: overlay; pointer-events: none; z-index: 2;
        }

        #lens-rain {
          position: absolute; inset: 0; z-index: 3; pointer-events: none;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.6' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
          backdrop-filter: blur(1px); -webkit-backdrop-filter: blur(1px);
        }

        /* ── Ambient whisper (Cruz 狀態低語) ── */
        #ambient-whisper {
          position: absolute;
          bottom: 8%; left: 50%; transform: translateX(-50%);
          z-index: 15; pointer-events: none;
          font-size: 0.75rem; letter-spacing: 0.15em;
          color: rgba(212,163,115,0.6);
          opacity: 0;
          transition: opacity 3s ease;
          text-align: center;
          white-space: nowrap;
        }

        /* 微塵 */
        #dust-container { position: absolute; inset: 0; z-index: 4; pointer-events: none; overflow: hidden; }
        .dust-mote {
          position: absolute; border-radius: 50%; background: rgba(255,230,180,0.5);
          box-shadow: 0 0 6px rgba(255,230,180,0.6);
          animation: floatMote linear infinite;
        }
        @keyframes floatMote {
          0% { transform: translate(0,0) scale(0.8); opacity: 0; }
          20% { opacity: 0.8; }
          80% { opacity: 0.8; }
          100% { transform: translate(-50px,-150px) scale(1.2); opacity: 0; }
        }

        /* ── Layer 2: Hitboxes ── */
        .hitbox {
          position: absolute; z-index: 10; cursor: none;
        }
        #hitbox-cup { left: 21%; top: 58%; width: 17%; height: 26%; border-radius: 50%; }
        #hitbox-journal { left: 45%; top: 73%; width: 35%; height: 25%; transform: rotate(-5deg); }
        #hitbox-cruz { left: 63%; top: 22%; width: 18%; height: 38%; }

        .hover-glow {
          position: absolute; inset: 0; border-radius: inherit;
          box-shadow: 0 0 0px rgba(255,214,153,0);
          transition: box-shadow 0.5s ease;
        }
        .hitbox:hover .hover-glow {
          box-shadow: 0 0 40px rgba(255,214,153,0.15) inset;
        }

        /* 呼吸暗示 — 讓人知道可以按 */
        .hitbox .hint-pulse {
          position: absolute; border-radius: inherit;
          inset: 0;
          border: 1px solid rgba(212,163,115,0);
          animation: hitboxPulse 4s ease-in-out infinite;
          pointer-events: none;
        }
        #hitbox-cup .hint-pulse { animation-delay: 0s; }
        #hitbox-journal .hint-pulse { animation-delay: 1.3s; }
        #hitbox-cruz .hint-pulse { animation-delay: 2.6s; }
        #hitbox-laptop .hint-pulse { animation-delay: 3.9s; }
        @keyframes hitboxPulse {
          0%, 100% { border-color: rgba(212,163,115,0); box-shadow: none; }
          50% { border-color: rgba(212,163,115,0.25); box-shadow: 0 0 20px rgba(212,163,115,0.08); }
        }

        /* ── Layer 3: Dialogue ── */
        #interaction-layer {
          position: absolute; inset: 0; z-index: 20; pointer-events: none;
          display: flex; flex-direction: column; justify-content: flex-end; align-items: center;
          padding-bottom: 8vh;
        }

        .custom-dialogue {
          background: linear-gradient(180deg, rgba(15,20,25,0.6) 0%, rgba(10,12,16,0.85) 100%);
          backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(255,255,255,0.08);
          border-left: 3px solid #d4a373;
          padding: 28px 40px; border-radius: 12px;
          max-width: 650px; width: 90%;
          box-shadow: 0 30px 60px rgba(0,0,0,0.7);
          opacity: 0; transform: translateY(30px);
          transition: all 0.7s cubic-bezier(0.19,1,0.22,1);
          pointer-events: auto;
        }
        .custom-dialogue.active { opacity: 1; transform: translateY(0); }

        .dialogue-name {
          font-size: 0.75rem; color: #d4a373; letter-spacing: 0.3em;
          margin-bottom: 12px; text-transform: uppercase; font-family: sans-serif;
        }
        .dialogue-text {
          font-size: 1.15rem; color: #f1f5f9; line-height: 1.8;
          letter-spacing: 0.08em; font-weight: 300; min-height: 3.6rem;
          white-space: pre-wrap;
        }
        .cursor-blink::after {
          content: ' ▍'; animation: blink 1s step-end infinite; color: #d4a373;
        }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

        /* ── Magnetic Cursor ── */
        #cursor-follower {
          position: absolute; width: 12px; height: 12px; background: rgba(255,255,255,0.8);
          border-radius: 50%; pointer-events: none; z-index: 100;
          transition: width 0.3s, height 0.3s, background 0.3s, border 0.3s;
          transform: translate(-50%,-50%); mix-blend-mode: exclusion;
          box-shadow: 0 0 10px rgba(255,255,255,0.5);
        }
        #cursor-follower.magnetic {
          width: 50px; height: 50px; background: transparent;
          border: 1px solid rgba(212,163,115,0.6); mix-blend-mode: normal;
          box-shadow: inset 0 0 15px rgba(212,163,115,0.2);
        }

        /* ── Intro ── */
        #intro-screen {
          position: absolute; inset: 0; background: #030508; z-index: 200;
          display: flex; flex-direction: column; justify-content: center; align-items: center;
          transition: opacity 2s ease; cursor: pointer;
        }
        .start-btn {
          font-size: 0.9rem; color: rgba(255,255,255,0.4); letter-spacing: 0.4em;
          border: 1px solid rgba(255,255,255,0.1); padding: 15px 40px; border-radius: 4px;
          transition: all 0.5s; background: transparent;
        }
        .start-btn:hover {
          color: #fff; border-color: rgba(212,163,115,0.6); background: rgba(212,163,115,0.05);
        }

        /* ── TG Bulletin Board (電報牆) ── */
        #tg-bulletin {
          display: none;
          position: absolute;
          left: 3%; top: 30%;
          width: 180px;
          z-index: 12;
          flex-direction: column;
          gap: 6px;
          padding: 14px 12px;
          background: rgba(30,25,18,0.7);
          border: 1px solid rgba(212,163,115,0.15);
          border-radius: 6px;
          backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
          pointer-events: none;
          opacity: 0;
          transition: opacity 2s ease 10s;
        }
        #base-layer.awake ~ #viewport #tg-bulletin,
        #base-layer.awake ~ * #tg-bulletin { opacity: 1; }
        .tg-header {
          font-size: 9px; letter-spacing: 0.3em; text-transform: uppercase;
          color: rgba(212,163,115,0.4); margin-bottom: 4px;
        }
        .tg-msg {
          display: flex; gap: 6px; align-items: baseline;
          font-size: 11px; line-height: 1.5; color: rgba(255,255,255,0.45);
        }
        .tg-time {
          font-size: 9px; color: rgba(212,163,115,0.35);
          font-family: 'Courier New', monospace; flex-shrink: 0;
        }
        .tg-text { word-break: break-all; }
        @media (max-width: 767px) {
          #tg-bulletin { display: none !important; }
        }

        /* ── Laptop Hitbox + Modal (虛擬桌面) ── */
        #hitbox-laptop { left: 5%; top: 68%; width: 18%; height: 22%; }
        #desktop-modal {
          display: none;
          position: fixed; inset: 0;
          z-index: 60;
          background: rgba(0,0,0,0.85);
          justify-content: center; align-items: center;
          flex-direction: column;
        }
        #desktop-modal.modal-open { display: flex; }
        #desktop-preview {
          width: 80vw; max-width: 700px;
          height: 50vh;
          background: #0a0c10;
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 8px;
          display: flex; align-items: center; justify-content: center;
          overflow: hidden;
          font-family: 'Courier New', monospace;
          font-size: 12px; color: rgba(255,255,255,0.6);
          line-height: 1.6;
          padding: 20px;
          white-space: pre-wrap;
          text-align: left;
        }
        #desktop-close {
          margin-top: 16px;
          font-size: 11px; letter-spacing: 0.2em;
          color: rgba(255,255,255,0.3);
          cursor: pointer; padding: 8px 24px;
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 4px;
          transition: color 0.2s, border-color 0.2s;
        }
        #desktop-close:hover { color: #fff; border-color: rgba(212,163,115,0.4); }

        /* ── Cafe Input Box (T-06/T-07) ── */
        #cafe-input-container {
          position: fixed;
          bottom: 24px; left: 50%;
          transform: translateX(-50%);
          z-index: 25;
          width: 90%; max-width: 500px;
          opacity: 0;
          transition: opacity 1s ease;
        }
        #cafe-input {
          width: 100%;
          background: rgba(10,12,16,0.6);
          backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 8px;
          padding: 12px 18px;
          font-family: 'Noto Serif TC', serif;
          font-size: 14px;
          color: rgba(255,255,255,0.8);
          letter-spacing: 0.05em;
          outline: none;
          box-sizing: border-box;
          transition: border-color 0.3s;
        }
        #cafe-input::placeholder {
          color: rgba(255,255,255,0.2);
          letter-spacing: 0.08em;
        }
        #cafe-input:focus {
          border-color: rgba(212,163,115,0.4);
        }

        /* ── Mobile: disable custom cursor ── */
        @media (max-width: 767px) {
          body, html { cursor: auto; }
          #cursor-follower { display: none; }
          .hitbox { cursor: pointer; }
          #cafe-input-container { bottom: 12px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .dust-mote, #ambient-light { animation: none; }
        }

        /* ── Layer 2.5: Napkin Oracle ── */
        #napkin-oracle {
          display: none;
          position: absolute;
          z-index: 15;
          /* 杯子附近 — hitbox-cup: left:21% top:58% */
          left: 30%;
          top: 46%;
          width: 260px;
          flex-direction: column;
          align-items: flex-start;
          padding: 18px 22px 20px;
          background: rgba(245,240,230,0.92);
          border-radius: 3px 10px 8px 4px;
          clip-path: polygon(0% 2%, 2% 0%, 98% 0%, 100% 3%, 100% 97%, 97% 100%, 3% 100%, 0% 97%);
          box-shadow: 2px 4px 12px rgba(0,0,0,0.35), 0 1px 3px rgba(0,0,0,0.2);
          transform: rotate(-2deg) translateY(10px);
          opacity: 0;
          transition: opacity 1.5s ease, transform 1.5s ease;
          cursor: pointer;
          pointer-events: none;
        }
        #napkin-oracle.napkin-visible {
          opacity: 1;
          transform: rotate(-2deg) translateY(0);
          pointer-events: auto;
        }
        #napkin-oracle.napkin-fly {
          opacity: 0;
          transform: rotate(-6deg) translateY(-40px) scale(0.92);
          transition: opacity 0.8s ease, transform 0.8s cubic-bezier(0.22,0.61,0.36,1);
          pointer-events: none;
        }
        .napkin-label {
          font-family: sans-serif;
          font-size: 8px;
          letter-spacing: 0.35em;
          color: rgba(60,40,20,0.35);
          text-transform: uppercase;
          margin-bottom: 10px;
        }
        .napkin-text {
          font-family: 'Noto Serif TC', serif;
          font-style: italic;
          font-size: 0.85rem;
          line-height: 1.75;
          letter-spacing: 0.05em;
          color: rgba(60,40,20,0.82);
        }
        .napkin-dismiss-hint {
          margin-top: 14px;
          font-family: sans-serif;
          font-size: 9px;
          letter-spacing: 0.2em;
          color: rgba(60,40,20,0.3);
          align-self: flex-end;
        }
        @media (max-width: 767px) {
          #napkin-oracle {
            left: 50%;
            top: 40%;
            transform: translateX(-50%) rotate(-2deg) translateY(10px);
            width: 78vw;
            max-width: 300px;
          }
          #napkin-oracle.napkin-visible {
            transform: translateX(-50%) rotate(-2deg) translateY(0);
          }
          #napkin-oracle.napkin-fly {
            transform: translateX(-50%) rotate(-6deg) translateY(-40px) scale(0.92);
          }
        }

        /* ──────────────────────────────────────
           Notebook Panel — Frosted Glass
        ────────────────────────────────────── */

        /* Trigger button — bottom-right */
        #notebook-trigger {
          position: fixed;
          bottom: 24px; right: 24px;
          width: 44px; height: 44px;
          z-index: 40;
          cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          background: rgba(10,12,16,0.5);
          border: 1px solid rgba(255,255,255,0.18);
          border-radius: 8px;
          transition: background 0.2s, border-color 0.2s, opacity 0.3s;
          user-select: none; -webkit-user-select: none;
          touch-action: manipulation;
          opacity: 0;
          pointer-events: none;
        }
        #notebook-trigger.visible {
          opacity: 1;
          pointer-events: auto;
        }
        #notebook-trigger:hover {
          background: rgba(212,163,115,0.12);
          border-color: rgba(212,163,115,0.4);
        }
        #notebook-trigger.hidden { opacity: 0 !important; pointer-events: none !important; }

        /* Panel */
        #notebook-panel {
          position: fixed;
          top: 0; bottom: 0; right: 0;
          width: 85vw; max-width: 420px;
          z-index: 50;
          display: flex; flex-direction: column;
          transform: translateX(100%);
          transition: transform 0.5s ease;
          backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
          background: rgba(10,12,16,0.75);
          border-left: 1px solid rgba(255,255,255,0.07);
          box-shadow: -12px 0 40px rgba(0,0,0,0.6);
          overflow: hidden;
          font-family: 'Noto Serif TC', serif;
          color: #e2d9cc;
          user-select: none; -webkit-user-select: none;
          box-sizing: border-box;
        }
        #notebook-panel.notebook-open { transform: translateX(0); }

        /* Dimmed state for base-layer */
        #base-layer.nb-dimmed {
          filter: blur(6px) brightness(0.35) !important;
          transition: filter 0.5s ease !important;
        }

        /* Header */
        .nb-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 18px 20px 12px 20px;
          border-bottom: 1px solid rgba(255,255,255,0.07);
          flex-shrink: 0;
        }
        .nb-title {
          font-size: 11px; letter-spacing: 0.4em; color: rgba(255,255,255,0.3);
          text-transform: uppercase; font-weight: 300;
        }
        .nb-close {
          width: 32px; height: 32px;
          display: flex; align-items: center; justify-content: center;
          font-size: 22px; cursor: pointer;
          color: rgba(255,255,255,0.3); border-radius: 6px;
          transition: color 0.15s, background 0.15s;
          line-height: 1;
        }
        .nb-close:hover { color: #fff; background: rgba(255,255,255,0.07); }

        /* Tabs */
        .nb-tabs {
          display: flex; flex-shrink: 0;
          padding: 0 20px;
          border-bottom: 1px solid rgba(255,255,255,0.07);
        }
        .nb-tab {
          flex: 1; text-align: center;
          padding: 11px 4px 10px;
          font-size: 13px; letter-spacing: 0.12em;
          cursor: pointer;
          color: rgba(255,255,255,0.3);
          border-bottom: 2px solid transparent;
          transition: color 0.2s, border-color 0.2s;
        }
        .nb-tab:hover { color: rgba(255,255,255,0.6); }
        .nb-tab.active { color: #d4a373; border-bottom-color: #d4a373; }

        /* Body */
        .nb-body {
          flex: 1; overflow-y: auto; overflow-x: hidden;
          padding: 20px 22px 32px;
          -webkit-overflow-scrolling: touch;
          overscroll-behavior: contain;
        }
        .nb-body::-webkit-scrollbar { width: 3px; }
        .nb-body::-webkit-scrollbar-thumb { background: rgba(212,163,115,0.2); border-radius: 2px; }

        .nb-tab-pane { display: none; }
        .nb-tab-pane.active { display: block; }

        /* Section label */
        .nb-section-label {
          font-size: 10px; letter-spacing: 0.4em; text-transform: uppercase;
          color: rgba(255,255,255,0.2); margin-bottom: 18px;
        }

        /* Morning tab */
        .nb-morning-placeholder {
          padding: 48px 0; text-align: center;
          color: rgba(255,255,255,0.18);
          font-size: 13px; line-height: 2.2; letter-spacing: 0.08em;
        }

        /* Scrolls tab */
        .nb-scroll-card {
          border: 1px solid rgba(212,163,115,0.15);
          border-radius: 8px; padding: 14px 16px; margin-bottom: 12px;
          background: rgba(212,163,115,0.03);
          transition: border-color 0.2s, background 0.2s;
        }
        .nb-scroll-card:hover {
          border-color: rgba(212,163,115,0.32);
          background: rgba(212,163,115,0.06);
        }
        .nb-scroll-row {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 5px;
        }
        .nb-scroll-title {
          font-size: 13px; font-weight: 500;
          color: #e2d9cc; letter-spacing: 0.04em;
        }
        .nb-scroll-lock { font-size: 11px; color: rgba(255,255,255,0.22); }
        .nb-scroll-lock.unlocked { color: rgba(212,163,115,0.65); }
        .nb-scroll-hint {
          font-size: 11px; color: rgba(255,255,255,0.28);
          line-height: 1.5; font-style: italic;
        }
        .nb-scroll-empty {
          text-align: center; padding: 40px 10px;
          color: rgba(255,255,255,0.18);
          font-size: 12px; line-height: 2; letter-spacing: 0.05em;
        }

        /* Journey tab */
        .nb-journey-card {
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 8px; padding: 16px 18px;
          background: rgba(255,255,255,0.025);
          margin-bottom: 12px;
        }
        .nb-stat-row {
          display: flex; justify-content: space-between; align-items: center;
          padding: 9px 0;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          font-size: 13px;
        }
        .nb-stat-row:last-child { border-bottom: none; }
        .nb-stat-label { color: rgba(255,255,255,0.32); letter-spacing: 0.04em; }
        .nb-stat-value {
          color: #d4a373; font-weight: 500;
          font-size: 11px; letter-spacing: 0.1em;
          font-family: 'Courier New', monospace;
        }
      `}</style>

      {/* Intro Screen */}
      <div id="intro-screen" onClick={() => (window as any).__cafe?.boot()}>
        <div className="text-center mb-8">
          <h1
            style={{
              fontSize: '1.5rem',
              fontWeight: 300,
              letterSpacing: '0.5em',
              color: '#e5e7eb',
              marginBottom: '8px',
            }}
          >
            THINKER CAFE
          </h1>
          <p
            style={{
              fontSize: '10px',
              color: '#374151',
              letterSpacing: '0.3em',
              textTransform: 'uppercase',
            }}
          >
            Cinematic Engine v2.0
          </p>
        </div>
        <button className="start-btn">連線至庇護所</button>
        <div
          style={{
            marginTop: '48px',
            fontSize: '10px',
            color: '#374151',
            letterSpacing: '0.15em',
          }}
        >
          ※ 啟動聲學模組，請配戴耳機
        </div>
      </div>

      {/* Viewport */}
      <div
        id="viewport"
        style={{
          position: 'relative',
          width: '100vw',
          height: '100vh',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <div id="base-layer" />
        <div id="person-blur" />
        <div id="ambient-light" />
        <div id="window-light" />
        <div id="dust-container" />
        <div id="lens-rain" />
        <div id="ambient-whisper" />

        {/* Napkin Oracle */}
        <div
          id="napkin-oracle"
          onClick={() => (window as any).__cafe?.napkin.dismiss()}
        >
          <div className="napkin-label">今日手記</div>
          <div className="napkin-text" />
          <div className="napkin-dismiss-hint">點擊 · 閱後即焚</div>
        </div>

        {/* TG Bulletin Board */}
        <div id="tg-bulletin" />

        {/* Hitboxes */}
        <div
          id="hitbox-cup"
          className="hitbox"
          onClick={() => {
            const cafe = (window as any).__cafe;
            if (!cafe) return;
            const sp = (window as any).__cafeSP;
            if (cafe._spData && sp) sp.recordInteraction('cup', cafe._spData);
            const api = (window as any).__cafeAPI;
            if (api) {
              api.sendCoffee('cruz').then((res: any) => {
                if (res?.forceClose && res?.farewell) {
                  cafe.narrative.scripts['forceclose'] = { name: 'Cruz', text: res.farewell };
                  cafe.narrative.trigger('forceclose');
                  return;
                }
                if (res?.total) {
                  cafe.narrative.scripts['cup'] = {
                    name: 'Cruz',
                    text: `這只杯子放很久了，金色裂痕還是很亮。喝吧，溫度剛剛好。\n（今天共有 ${res.today} 杯咖啡被送出，你是第 ${res.total} 杯。）`,
                  };
                }
                cafe.narrative.trigger('cup');
              }).catch(() => cafe.narrative.trigger('cup'));
            } else {
              cafe.narrative.trigger('cup');
            }
          }}
        >
          <div className="hover-glow" /><div className="hint-pulse" />
        </div>
        <div
          id="hitbox-journal"
          className="hitbox"
          onClick={() => {
            const cafe = (window as any).__cafe;
            const sp = (window as any).__cafeSP;
            if (cafe?._spData && sp) sp.recordInteraction('journal', cafe._spData);
            cafe?.narrative.trigger('journal');
          }}
        >
          <div className="hover-glow" /><div className="hint-pulse" />
        </div>
        <div
          id="hitbox-cruz"
          className="hitbox"
          onClick={() => {
            const cafe = (window as any).__cafe;
            const sp = (window as any).__cafeSP;
            if (cafe?._spData && sp) sp.recordInteraction('cruz', cafe._spData);
            cafe?.narrative.trigger('cruz');
          }}
        >
          <div className="hover-glow" /><div className="hint-pulse" />
        </div>
        <div
          id="hitbox-laptop"
          className="hitbox"
          onClick={() => {
            const modal = document.getElementById('desktop-modal');
            const preview = document.getElementById('desktop-preview');
            if (!modal || !preview) return;
            modal.classList.add('modal-open');
            // Screenshot mode: show cmux state snapshot
            preview.textContent = 'connecting to desktop...';
            fetch('/cafe-game/data/ambient-state.json')
              .then(r => r.ok ? r.json() : null)
              .then(state => {
                const mood = state?.mood || 'present';
                const doing = state?.doing || '—';
                preview.textContent = [
                  '┌─────────────────────────────────────┐',
                  '│  cmux — Cruz\'s Terminal              │',
                  '├─────────────────────────────────────┤',
                  `│  Status: ${mood.padEnd(27)}│`,
                  `│  Doing:  ${doing.padEnd(27)}│`,
                  '│                                     │',
                  '│  Sessions:                          │',
                  '│    [A] cafe-engine    ● active       │',
                  '│    [G] g9-analytics   ○ idle         │',
                  '│    [B] bg666-data     ○ idle         │',
                  '│                                     │',
                  '│  > _                                 │',
                  '└─────────────────────────────────────┘',
                ].join('\n');
              })
              .catch(() => {
                preview.textContent = 'connection failed. desktop is offline.';
              });
          }}
        >
          <div className="hover-glow" /><div className="hint-pulse" />
        </div>

        {/* Desktop Modal */}
        <div id="desktop-modal">
          <div id="desktop-preview" />
          <div
            id="desktop-close"
            onClick={() => document.getElementById('desktop-modal')?.classList.remove('modal-open')}
          >
            ESC · 關閉
          </div>
        </div>

        {/* Dialogue */}
        <div id="interaction-layer">
          <div id="dialogue-box" className="custom-dialogue">
            <div className="dialogue-name" id="d-name">System</div>
            <div className="dialogue-text cursor-blink" id="d-text" />
          </div>
        </div>

        <div id="cursor-follower" />
      </div>

      {/* ── Cafe Input Box (Trojan CLI) ── */}
      <div id="cafe-input-container">
        <input
          id="cafe-input"
          type="text"
          placeholder="說點什麼..."
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {/* ── Notebook Trigger Button ── */}
      <div id="notebook-trigger" role="button" aria-label="手帳本">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="4" y="2" width="14" height="18" rx="1.5" stroke="rgba(255,255,255,0.3)" strokeWidth="1.4"/>
          <line x1="4" y1="2" x2="4" y2="20" stroke="rgba(255,255,255,0.3)" strokeWidth="2.2" strokeLinecap="round"/>
          <line x1="7.5" y1="7" x2="15" y2="7" stroke="rgba(255,255,255,0.25)" strokeWidth="1"/>
          <line x1="7.5" y1="10.5" x2="15" y2="10.5" stroke="rgba(255,255,255,0.25)" strokeWidth="1"/>
          <line x1="7.5" y1="14" x2="12" y2="14" stroke="rgba(255,255,255,0.25)" strokeWidth="1"/>
        </svg>
      </div>

      {/* ── Notebook Panel ── */}
      <div id="notebook-panel" role="dialog" aria-label="手帳本">
        <div className="nb-header">
          <span className="nb-close" role="button" aria-label="關閉" id="nb-close-btn">×</span>
          <span className="nb-title">手帳本</span>
        </div>

        <div className="nb-tabs" id="nb-tabs">
          <div className="nb-tab active" data-tab="morning">晨報</div>
          <div className="nb-tab" data-tab="scrolls">卷軸</div>
          <div className="nb-tab" data-tab="journey">旅程</div>
          <div className="nb-tab" data-tab="workshop">工坊</div>
        </div>

        <div className="nb-body">
          <div className="nb-tab-pane active" id="nb-pane-morning">
            <div className="nb-section-label">Morning Briefing</div>
            <div className="nb-morning-placeholder" id="nb-morning-content">
              晨報準備中...<br/>
              <span style={{fontSize: '11px', opacity: 0.6}}>尚未連線至心跳系統</span>
            </div>
          </div>

          <div className="nb-tab-pane" id="nb-pane-scrolls">
            <div className="nb-section-label">Collected Scrolls</div>
            <div id="nb-scrolls-content" />
          </div>

          <div className="nb-tab-pane" id="nb-pane-journey">
            <div className="nb-section-label">Your Journey</div>
            <div className="nb-journey-card" id="nb-journey-content" />
          </div>

          <div className="nb-tab-pane" id="nb-pane-workshop">
            <div className="nb-section-label">Your Workshop</div>
            <div id="nb-workshop-content" />
          </div>
        </div>
      </div>
    </>
  );
}
