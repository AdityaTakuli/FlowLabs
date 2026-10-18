// The intro and loading screen, and ScrambleText: letters cycle through random characters before
// settling, left to right, each time the text changes. Reduced motion shows the text at once.
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { LogoMark } from "./TopBar";

const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+=<>?/";

export function ScrambleText({ text, duration = 0.9, delay = 0, className }: { text: string; duration?: number; delay?: number; className?: string }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced ? text : "");
  useEffect(() => {
    if (reduced) {
      setShown(text);
      return;
    }
    // each character settles at its own moment, roughly left to right
    const settle = [...text].map((_, i) => (i / Math.max(1, text.length)) * 0.65 + Math.random() * 0.35);
    let frame = 0;
    let last = 0;
    const start = performance.now() + delay * 1000;
    const tick = (now: number) => {
      const t = (now - start) / (duration * 1000);
      if (now - last > 45 || t >= 1) {
        last = now;
        setShown(
          t < 0
            ? ""
            : [...text].map((char, i) => (char === " " || t >= settle[i]! ? char : GLYPHS[Math.floor(Math.random() * GLYPHS.length)])).join(""),
        );
      }
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, duration, delay, reduced]);
  return (
    <span className={className} aria-label={text}>
      <span aria-hidden>{shown || " "}</span>
    </span>
  );
}

/** A row of dots that fills with progress, or a lit band that sweeps when progress is unknown. */
function DotProgress({ value }: { value?: number }) {
  const count = 28;
  const lit = value === undefined ? -1 : Math.round(Math.max(0, Math.min(1, value)) * count);
  return (
    <div className={`dot-progress ${value === undefined ? "sweep" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === undefined ? undefined : Math.round(value * 100)}>
      {Array.from({ length: count }, (_, i) => (
        <i key={i} className={i < lit ? "on" : ""} style={{ animationDelay: `${i * 55}ms` }} />
      ))}
    </div>
  );
}

export function Intro({ message, progress, note, error }: { message: string; progress?: number; note?: string; error?: ReactNode }) {
  return (
    <motion.div className="splash" initial={{ opacity: 1 }} exit={{ opacity: 0, scale: 1.015, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } }}>
      <div className="splash-card">
        <motion.div initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 18 }}>
          <LogoMark size={56} />
        </motion.div>
        <h1 className="splash-title">
          <ScrambleText text="FlowLabs" duration={1.1} />
        </h1>
        <p className="splash-tagline">
          <ScrambleText text="Data, SQL and machine learning in one place" duration={1} delay={0.35} />
        </p>
        {error ?? (
          <>
            <DotProgress value={progress} />
            <p className="splash-status">
              <ScrambleText key={message} text={message} duration={0.6} />
            </p>
            {note && <p className="splash-note">{note}</p>}
          </>
        )}
      </div>
    </motion.div>
  );
}
