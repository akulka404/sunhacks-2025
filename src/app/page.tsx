"use client";

import { useEffect, useRef, useState } from "react";

export default function HomePage() {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);

  // Auto-expanding textarea for prompt
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const autoResize = () => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(220, Math.max(56, el.scrollHeight));
    el.style.height = `${next}px`;
  };
  useEffect(() => { autoResize(); }, [prompt]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setLoading(true);
    try {
        const res = await fetch("/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
        const data = await res.json().catch(() => null);
        if (data?.ok && data?.plan) {
          sessionStorage.setItem("crisisverse.lastPrompt", prompt);
          sessionStorage.setItem("crisisverse.plan", JSON.stringify(data.plan));
          window.location.href = "/simulation";
        }
    } catch (err) {
      // noop for now
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="center">
      <div className="card" role="region" aria-label="CrisisVerse prompt" style={{ maxWidth: "min(900px, 96vw)", width: "100%" }}>
          <h1 className="title">CrisisVerse v1.0</h1>
          <p className="subtitle">Type a crisis scenario to simulate.</p>

          <form onSubmit={onSubmit} aria-label="Start simulation form" style={{ display: 'grid', gap: 12 }}>
            <div className="promptRow" style={{ alignItems: 'start' }}>
              <textarea
                ref={textRef}
                className="input"
                name="prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="What threat or crisis scenario would you like to assess?"
                aria-label="Prompt"
                rows={2}
                style={{ resize: 'none', transition: 'height 180ms ease', lineHeight: 1.35 }}
              />
              <button className="button" type="submit" disabled={loading}>
                {loading ? "starting…" : "start simulation"}
              </button>
            </div>
          </form>

              <div className="footer">CrisisVerse v1.0 • Powered by Google Gemini 2.5 Flash • Saving Lives Sustainably</div>
      </div>
    </main>
  );
}
