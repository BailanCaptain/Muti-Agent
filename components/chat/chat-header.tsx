"use client";

import { Download, LayoutGrid, Menu, PawPrint, Radio, Smartphone } from "lucide-react";

export function ChatHeader() {
  return (
    <header className="flex items-center justify-between border-b border-black/5 bg-white/55 px-6 py-4 backdrop-blur-xl">
      <div className="flex items-center gap-4">
        <button className="rounded-full p-2 transition hover:bg-black/5" type="button">
          <Menu className="h-5 w-5 text-slate-500" />
        </button>

        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-orange-100 text-orange-500 shadow-[0_10px_24px_rgba(249,115,22,0.16)]">
            <PawPrint className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-[0.01em] text-slate-800">Multi-Agent</h1>
            <p className="text-xs text-slate-400">Multi-Agent的协作空间</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {[
          { icon: Download, label: "下载" },
          { icon: Radio, label: "广播" },
          { icon: LayoutGrid, label: "切换布局" },
          { icon: Smartphone, label: "移动端" }
        ].map((item) => (
          <button
            className="rounded-full p-2 text-slate-400 transition hover:bg-black/5 hover:text-slate-600"
            key={item.label}
            title={item.label}
            type="button"
          >
            <item.icon className="h-5 w-5" />
          </button>
        ))}
      </div>
    </header>
  );
}
