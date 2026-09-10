import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Send, Trash2, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PickOrb, type OrbMode } from "@/components/pick-orb";
import { askPick, askPickInBrowser, transcribeUtterance, type ChatTurn } from "@/lib/pick";
import { cn } from "@/lib/utils";

const HISTORY_KEY = "stick.history.v1";
const MUTE_KEY = "pick.muted";
const MAX_TURNS = 12;
const SETTLE_MS = 900;
const IDLE_STATUS = "Tap him to turn the mic on. Tap again to turn it off.";
const STARTER_PROMPTS = [
  "Give me a tiny pep talk",
  "Help me pick dinner",
  "Tell me something weird",
];

type Line = ChatTurn & { id: string };

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function getRecognition(): SpeechRecognition | null {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 3;
  return rec;
}

function bestTranscript(piece: SpeechRecognitionResult) {
  let best = piece[0];
  let score = best?.confidence ?? 0;
  for (let i = 1; i < piece.length; i++) {
    const alt = piece[i];
    const c = alt?.confidence ?? 0;
    if (alt && c > score) {
      best = alt;
      score = c;
    }
  }
  return { text: (best?.transcript ?? "").trim(), confidence: score };
}

function tidyTranscript(raw: string) {
  return raw
    .replace(/\s+/g, " ")
    .replace(/[.]{2,}/g, ".")
    .trim();
}

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices?.() ?? [];
  if (!voices.length) return null;
  const ranked = [
    /google uk english male/i,
    /microsoft guy/i,
    /microsoft david/i,
    /daniel/i,
    /alex/i,
    /fred/i,
    /english male/i,
    /en-gb/i,
    /^en[-_]/i,
  ];
  for (const re of ranked) {
    const hit = voices.find((v) => re.test(v.name) || re.test(v.lang));
    if (hit) return hit;
  }
  return voices.find((v) => v.lang.toLowerCase().startsWith("en")) ?? voices[0] ?? null;
}

function unlockSpeech() {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  window.speechSynthesis.speak(u);
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

export function PickStudio() {
  const [lines, setLines] = useState<Line[]>([]);
  const [mode, setMode] = useState<OrbMode>("idle");
  const [micOn, setMicOn] = useState(false);
  const [level, setLevel] = useState(0);
  const [draft, setDraft] = useState("");
  const [interim, setInterim] = useState("");
  const [muted, setMuted] = useState(false);
  const [canHear, setCanHear] = useState(true);
  const [status, setStatus] = useState(IDLE_STATUS);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<SpeechRecognition | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef(0);
  const modeRef = useRef<OrbMode>("idle");
  const micOnRef = useRef(false);
  const mutedRef = useRef(false);
  const sendingRef = useRef(false);
  const recPausedRef = useRef(false);
  const linesRef = useRef<Line[]>([]);
  const settleTimerRef = useRef<number>(0);
  const finalsRef = useRef("");
  const confidenceRef = useRef(0);
  const restartTimerRef = useRef<number>(0);
  const onUtteranceRef = useRef<(spoken: string, confidence: number) => void>(() => {});
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  modeRef.current = mode;
  micOnRef.current = micOn;
  mutedRef.current = muted;
  linesRef.current = lines;

  const stopMeter = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    analyserRef.current = null;
    try {
      recorderRef.current?.state !== "inactive" && recorderRef.current?.stop();
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    chunksRef.current = [];
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
    setLevel(0);
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Line[];
        if (Array.isArray(parsed)) setLines(parsed.slice(-MAX_TURNS));
      }
      setMuted(localStorage.getItem(MUTE_KEY) === "1");
    } catch {
      /* ignore */
    }
    setCanHear(Boolean(window.SpeechRecognition || window.webkitSpeechRecognition));
    setHydrated(true);

    const onVoices = () => pickVoice();
    window.speechSynthesis?.addEventListener?.("voiceschanged", onVoices);
    window.speechSynthesis?.getVoices?.();
    return () => {
      window.speechSynthesis?.removeEventListener?.("voiceschanged", onVoices);
      window.speechSynthesis?.cancel();
      recRef.current?.abort();
      window.clearTimeout(settleTimerRef.current);
      window.clearTimeout(restartTimerRef.current);
      stopMeter();
    };
  }, [stopMeter]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(lines.slice(-MAX_TURNS)));
    } catch {
      /* ignore */
    }
  }, [lines, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [muted, hydrated]);

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [lines, interim, mode]);

  const startMeter = useCallback(async () => {
    if (streamRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    streamRef.current = stream;
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    if (ctx.state === "suspended") await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyserRef.current = analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i]! - 128) / 128;
        sum += v * v;
      }
      setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();

    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
    try {
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.start(250);
      recorderRef.current = recorder;
    } catch {
      recorderRef.current = null;
    }
  }, []);

  const takeRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    const parts = chunksRef.current;
    chunksRef.current = [];
    if (!recorder || parts.length === 0) return null;
    const mime = recorder.mimeType || "audio/webm";
    const blob = new Blob(parts, { type: mime });
    if (blob.size < 1200) return null;
    return { blob, mime };
  }, []);

  const speakText = useCallback((text: string, audioBase64?: string, mime?: string) => {
    return new Promise<void>((resolve) => {
      if (mutedRef.current) {
        resolve();
        return;
      }

      const finish = () => resolve();

      if (audioBase64) {
        const audio = audioRef.current ?? new Audio();
        audioRef.current = audio;
        audio.src = `data:${mime || "audio/mpeg"};base64,${audioBase64}`;
        audio.onended = finish;
        audio.onerror = finish;
        setMode("speaking");
        setStatus("Speaking — mic stays on.");
        audio.play().catch(finish);
        return;
      }

      if (!window.speechSynthesis) {
        finish();
        return;
      }
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.08;
      u.pitch = 1.02;
      u.lang = "en-US";
      const voice = pickVoice();
      if (voice) u.voice = voice;
      u.onend = finish;
      u.onerror = finish;
      setMode("speaking");
      setStatus("Speaking — mic stays on.");
      window.speechSynthesis.speak(u);
    });
  }, []);

  const attachRecognition = useCallback((rec: SpeechRecognition) => {
    rec.onresult = (event) => {
      if (recPausedRef.current || sendingRef.current) return;
      let live = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const piece = event.results[i];
        if (!piece) continue;
        const { text, confidence } = bestTranscript(piece);
        if (!text) continue;
        if (piece.isFinal) {
          finalsRef.current = tidyTranscript(`${finalsRef.current} ${text}`);
          if (confidence > confidenceRef.current) confidenceRef.current = confidence;
        } else {
          live += ` ${text}`;
        }
      }
      setInterim(tidyTranscript(`${finalsRef.current} ${live}`));
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = window.setTimeout(() => {
        const spoken = tidyTranscript(finalsRef.current);
        const confidence = confidenceRef.current;
        finalsRef.current = "";
        confidenceRef.current = 0;
        setInterim("");
        if (spoken.length >= 2) onUtteranceRef.current(spoken, confidence);
      }, SETTLE_MS);
    };
    rec.onerror = (event) => {
      if (event.error === "not-allowed") {
        setError("Mic is blocked. Allow the microphone, or type.");
        setCanHear(false);
        micOnRef.current = false;
        setMicOn(false);
        recPausedRef.current = true;
        setMode("idle");
        setStatus(IDLE_STATUS);
        stopMeter();
        return;
      }
      if (event.error === "aborted" || event.error === "no-speech") return;
      if (event.error === "network") return;
      setError("Couldn't catch that. Keep talking, or type.");
    };
    rec.onend = () => {
      recRef.current = null;
      if (!micOnRef.current || recPausedRef.current) return;
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = window.setTimeout(() => {
        if (!micOnRef.current || recPausedRef.current) return;
        const next = getRecognition();
        if (!next) return;
        attachRecognition(next);
        recRef.current = next;
        try {
          next.start();
        } catch {
          /* already started */
        }
      }, 140);
    };
  }, [stopMeter]);

  const pauseListening = useCallback(() => {
    recPausedRef.current = true;
    window.clearTimeout(settleTimerRef.current);
    window.clearTimeout(restartTimerRef.current);
    try {
      recRef.current?.abort();
    } catch {
      /* ignore */
    }
    recRef.current = null;
  }, []);

  const resumeListening = useCallback(() => {
    if (!micOnRef.current) return;
    recPausedRef.current = false;
    setMode("listening");
    setStatus("Mic on. Keep talking.");
    if (recRef.current) return;
    const rec = getRecognition();
    if (!rec) return;
    attachRecognition(rec);
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      /* already started */
    }
  }, [attachRecognition]);

  const sendText = useCallback(
    async (content: string, clip?: { blob: Blob; mime: string } | null, confidence = 1) => {
      const spoken = tidyTranscript(content);
      if (!spoken || sendingRef.current) return;
      sendingRef.current = true;
      pauseListening();
      setInterim("");
      setError(null);
      setDraft("");

      let text = spoken;
      if (clip && (confidence < 0.72 || spoken.split(" ").length < 3)) {
        try {
          const audioBase64 = await blobToBase64(clip.blob);
          const result = await transcribeUtterance({
            data: { audioBase64, mime: clip.mime, hint: spoken },
          });
          if (result.ok && result.text) text = tidyTranscript(result.text);
        } catch {
          /* keep web-speech text */
        }
      }

      const userLine: Line = { id: newId(), role: "user", content: text };
      const history: ChatTurn[] = [...linesRef.current, userLine]
        .slice(-MAX_TURNS)
        .map(({ role, content: body }) => ({ role, content: body }));
      setLines((prev) => [...prev, userLine].slice(-MAX_TURNS * 2));
      setMode("thinking");
      setStatus("Thinking");

      try {
        let result = await askPick({ data: { messages: history } });
        if (!result.ok) result = await askPickInBrowser(history);
        if (!result.ok) {
          setError(result.error);
          if (micOnRef.current) resumeListening();
          else {
            setMode("idle");
            setStatus(IDLE_STATUS);
          }
          return;
        }
        const reply: Line = { id: newId(), role: "assistant", content: result.text };
        setLines((prev) => [...prev, reply].slice(-MAX_TURNS * 2));
        await speakText(result.text, result.audioBase64, result.mime);
        if (micOnRef.current) resumeListening();
        else {
          setMode("idle");
          setStatus(IDLE_STATUS);
        }
      } catch {
        setError("Stick's off-air. Try again in a sec.");
        if (micOnRef.current) resumeListening();
        else {
          setMode("idle");
          setStatus(IDLE_STATUS);
        }
      } finally {
        sendingRef.current = false;
      }
    },
    [pauseListening, resumeListening, speakText],
  );

  const handleUtterance = useCallback(
    async (spoken: string, confidence: number) => {
      const clip = await takeRecording();
      await sendText(spoken, clip, confidence);
    },
    [sendText, takeRecording],
  );

  useEffect(() => {
    onUtteranceRef.current = (spoken, confidence) => {
      void handleUtterance(spoken, confidence);
    };
  }, [handleUtterance]);

  const startListening = useCallback(async () => {
    setError(null);
    unlockSpeech();
    try {
      await startMeter();
    } catch {
      setError("Mic is blocked. Allow the microphone, or type.");
      setCanHear(false);
      return;
    }
    micOnRef.current = true;
    setMicOn(true);
    recPausedRef.current = false;
    finalsRef.current = "";
    setMode("listening");
    setStatus("Mic on. Keep talking.");
    const rec = getRecognition();
    if (!rec) {
      setCanHear(false);
      setStatus("This browser can't hear you. Type instead.");
      inputRef.current?.focus();
      return;
    }
    attachRecognition(rec);
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      setError("Couldn't start the mic. Type instead.");
      micOnRef.current = false;
      setMicOn(false);
      setMode("idle");
      setStatus(IDLE_STATUS);
    }
  }, [attachRecognition, startMeter]);

  const stopListening = useCallback(() => {
    micOnRef.current = false;
    setMicOn(false);
    recPausedRef.current = true;
    window.clearTimeout(settleTimerRef.current);
    window.clearTimeout(restartTimerRef.current);
    try {
      recRef.current?.abort();
    } catch {
      /* ignore */
    }
    recRef.current = null;
    const leftover = tidyTranscript(finalsRef.current);
    finalsRef.current = "";
    setInterim("");
    stopMeter();
    if (leftover.length >= 2 && !sendingRef.current) void sendText(leftover);
    if (!sendingRef.current) {
      setMode("idle");
      setStatus(IDLE_STATUS);
    }
  }, [sendText, stopMeter]);

  const onOrbToggle = useCallback(() => {
    if (micOnRef.current) {
      stopListening();
      return;
    }
    void startListening();
  }, [startListening, stopListening]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    unlockSpeech();
    void sendText(draft);
  };

  const clearChat = () => {
    window.speechSynthesis?.cancel();
    audioRef.current?.pause();
    setLines([]);
    setInterim("");
    setError(null);
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    if (next) {
      window.speechSynthesis?.cancel();
      audioRef.current?.pause();
      if (mode === "speaking") {
        if (micOnRef.current) {
          setMode("listening");
          setStatus("Mic on. Keep talking.");
        } else {
          setMode("idle");
          setStatus(IDLE_STATUS);
        }
      }
    }
  };

  const empty = lines.length === 0 && !interim;

  const statusLabel = useMemo(() => {
    if (mode === "listening") return "Mic on. Keep talking.";
    if (mode === "thinking") return "Thinking";
    if (mode === "speaking") return "Speaking — mic stays on.";
    return status;
  }, [mode, status]);

  return (
    <div className="relative flex min-h-dvh flex-col overflow-x-hidden bg-bg text-fg">
      <div className="grain" aria-hidden="true" />
      <header className="flex items-center justify-between gap-3 px-5 pb-2 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-8">
        <div className="min-w-0">
          <p className="font-display text-2xl font-medium leading-tight tracking-tight text-fg sm:text-3xl">
            Stick the Pick
          </p>
          <p className="text-xs font-medium tracking-wide text-muted">Your pal. Not that serious.</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={muted ? "Unmute Stick the Pick" : "Mute Stick the Pick"}
            aria-pressed={muted}
            onClick={toggleMute}
          >
            {muted ? <VolumeX /> : <Volume2 />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Clear conversation"
            onClick={clearChat}
            disabled={lines.length === 0}
          >
            <Trash2 />
          </Button>
        </div>
      </header>

      <section className="stagger-in flex flex-col items-center px-5 pb-4 pt-6 sm:pt-10">
        <PickOrb mode={mode} micOn={micOn} level={level} onToggle={onOrbToggle} />
        <div className="mt-5 flex items-center gap-2 text-sm text-muted">
          {micOn ? (
            <span className="live-dot size-1.5 rounded-full bg-live" aria-hidden="true" />
          ) : null}
          <p
            className={cn(
              "min-h-5 text-center",
              mode === "thinking" && "shimmer text-muted",
              micOn && mode === "listening" && "text-live",
              mode === "speaking" && "text-fg",
            )}
            aria-live="polite"
          >
            {statusLabel}
          </p>
        </div>
        {!canHear ? (
          <p className="mt-2 max-w-xs text-center text-xs text-subtle">
            Voice in needs Chrome or Edge. You can still type — he still talks.
          </p>
        ) : null}
      </section>

      <div
        ref={logRef}
        className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 overflow-y-auto px-5 py-2 sm:px-8"
      >
        {empty ? (
          <div className="mx-auto mt-4 flex max-w-md flex-col items-center gap-4 text-center">
            <p className="max-w-[22ch] font-display text-xl leading-snug text-muted sm:text-2xl">
              Say anything. He's right there. He'll talk back.
            </p>
            <div className="flex flex-wrap justify-center gap-2" aria-label="Starter prompts">
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="rounded-full px-3 py-2 text-xs font-medium text-muted shadow-[var(--shadow-border)] transition-colors hover:bg-surface hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                  onClick={() => void sendText(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {lines.map((line) => (
          <article
            key={line.id}
            className={cn(
              "max-w-[85%] animate-[rise-in_400ms_var(--ease-smooth-out)]",
              line.role === "user" ? "ml-auto text-right" : "mr-auto",
            )}
          >
            <p className="mb-1 text-[0.65rem] font-medium uppercase tracking-[0.14em] text-subtle">
              {line.role === "user" ? "You" : "Stick"}
            </p>
            <p
              className={cn(
                "text-pretty text-base leading-relaxed",
                line.role === "assistant"
                  ? "font-display text-lg text-fg sm:text-xl"
                  : "text-muted",
              )}
            >
              {line.content}
            </p>
          </article>
        ))}

        {interim ? (
          <article className="ml-auto max-w-[85%] text-right">
            <p className="mb-1 text-[0.65rem] font-medium uppercase tracking-[0.14em] text-subtle">
              You
            </p>
            <p className="text-base leading-relaxed text-muted italic">{interim}</p>
          </article>
        ) : null}

        {error ? (
          <p className="text-center text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <form
        onSubmit={onSubmit}
        className="mx-auto flex w-full max-w-xl items-center gap-2 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 sm:px-8"
      >
        <label className="sr-only" htmlFor="pick-draft">
          Type to Stick the Pick
        </label>
        <input
          ref={inputRef}
          id="pick-draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Or type it…"
          maxLength={500}
          autoComplete="off"
          suppressHydrationWarning
          className="h-12 min-w-0 flex-1 rounded-xl bg-surface px-4 text-base text-fg shadow-[var(--shadow-border)] placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        />
        <Button
          type="submit"
          size="icon"
          className="size-12 rounded-xl"
          aria-label="Send"
          disabled={!draft.trim() || mode === "thinking"}
        >
          <Send />
        </Button>
      </form>
    </div>
  );
}
