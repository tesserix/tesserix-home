"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Check,
  Facebook,
  Link2,
  Linkedin,
  Volume2,
  VolumeX,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  LAUNCH_PAGE_URL,
  groupReleasesByTarget,
  type LaunchGroup,
  type LaunchRelease,
} from "./launch-config";

/* ------------------------------------------------------------------ */
/* Time                                                                */
/* ------------------------------------------------------------------ */

// null until mounted so the server render never guesses at the clock.
function useSecondsLeft(targetMs: number): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  if (now === null) return null;
  return Math.max(0, Math.floor((targetMs - now) / 1000));
}

function splitSeconds(total: number) {
  return {
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3_600),
    minutes: Math.floor((total % 3_600) / 60),
    seconds: total % 60,
  };
}

/* ------------------------------------------------------------------ */
/* Tick-tock — synthesised, no audio asset                             */
/* ------------------------------------------------------------------ */

// Two alternating woodblock-ish taps: a brighter tick, a lower tock.
function playTick(ctx: AudioContext, tock: boolean) {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const freq = tock ? 640 : 980;
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.55, t + 0.06);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.28, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.12);
}

function useTickTock(secondsLeft: number | null) {
  const [soundOn, setSoundOn] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);

  // Creating the context inside the click handler satisfies autoplay policy.
  const toggle = useCallback(() => {
    setSoundOn((on) => {
      if (!on && !ctxRef.current) {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (!Ctor) return on;
        ctxRef.current = new Ctor();
      }
      void ctxRef.current?.resume();
      return !on;
    });
  }, []);

  useEffect(() => {
    if (!soundOn || secondsLeft === null || secondsLeft <= 0) return;
    const ctx = ctxRef.current;
    if (ctx) playTick(ctx, secondsLeft % 2 === 0);
  }, [soundOn, secondsLeft]);

  useEffect(() => {
    return () => {
      void ctxRef.current?.close();
      ctxRef.current = null;
    };
  }, []);

  return { soundOn, toggle };
}

/* ------------------------------------------------------------------ */
/* Split-flap digits                                                   */
/* ------------------------------------------------------------------ */

function FlipDigit({ value }: { value: string }) {
  const reduceMotion = useReducedMotion();
  return (
    // clip-path in addition to overflow-hidden: the animating digit gets its
    // own compositor layer, and Chromium can paint it outside a plain
    // overflow clip mid-animation; clip-path clips in the compositor too.
    <span className="relative inline-flex h-[1.15em] w-[0.62em] overflow-hidden [clip-path:inset(0)]">
      {/* Default sync mode: both digits are absolutely positioned, so the
          old one slides out while the new slides in, clipped by the parent.
          (popLayout repositions exiting elements in a way that escapes the
          overflow-hidden box — visible as stray half-digits.) */}
      <AnimatePresence initial={false}>
        {/* Animates `top` rather than transform: composited transform
            animations can escape overflow/clip-path clipping in Chromium,
            flashing half-digits outside the box. A layout property renders
            on the main thread and clips reliably — trivial at 1fps. */}
        <motion.span
          key={value}
          initial={
            reduceMotion ? { opacity: 0 } : { top: "-105%", opacity: 0.4 }
          }
          animate={{ top: "0%", opacity: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { top: "105%", opacity: 0.4 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-0 flex items-center justify-center"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function FlipNumber({ value, pad }: { value: number | null; pad: number }) {
  const text =
    value === null ? "–".repeat(pad) : String(value).padStart(pad, "0");
  return (
    <span className="inline-flex">
      {text.split("").map((digit, i) => (
        <FlipDigit key={`${text.length}-${i}`} value={digit} />
      ))}
    </span>
  );
}

function Colon({ dim }: { dim: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="mx-1 transition-opacity duration-300 sm:mx-2"
      style={{ opacity: dim ? 0.25 : 1 }}
    >
      :
    </span>
  );
}

function Countdown({
  secondsLeft,
  size = "hero",
}: {
  secondsLeft: number | null;
  size?: "hero" | "compact";
}) {
  const parts = secondsLeft === null ? null : splitSeconds(secondsLeft);
  const dim = secondsLeft !== null && secondsLeft % 2 === 1;
  const units = [
    { label: "Days", value: parts?.days ?? null },
    { label: "Hours", value: parts?.hours ?? null },
    { label: "Minutes", value: parts?.minutes ?? null },
    { label: "Seconds", value: parts?.seconds ?? null },
  ];

  return (
    <div
      role="timer"
      aria-live="off"
      aria-label="Time remaining until launch"
      className={
        size === "hero"
          ? "font-mono text-5xl font-medium tracking-tight text-foreground sm:text-7xl lg:text-8xl"
          : "font-mono text-3xl font-medium tracking-tight text-foreground sm:text-4xl"
      }
    >
      <div className="flex items-start justify-center">
        {units.map((unit, i) => (
          <span key={unit.label} className="flex items-start">
            {i > 0 && <Colon dim={dim} />}
            <span className="flex flex-col items-center gap-3">
              <FlipNumber value={unit.value} pad={2} />
              <span className="font-sans text-[0.16em] font-medium uppercase tracking-[0.25em] text-muted-foreground">
                {unit.label}
              </span>
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sharing                                                             */
/* ------------------------------------------------------------------ */

function shareUrls(url: string) {
  const encoded = encodeURIComponent(url);
  return {
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encoded}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encoded}`,
  };
}

function ShareRow({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const links = shareUrls(url);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions / http) — leave the button as-is.
    }
  }, [url]);

  const linkClass =
    "inline-flex items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary";

  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      <a
        href={links.facebook}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
      >
        <Facebook className="h-4 w-4" aria-hidden="true" />
        Share on Facebook
      </a>
      <a
        href={links.linkedin}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
      >
        <Linkedin className="h-4 w-4" aria-hidden="true" />
        Share on LinkedIn
      </a>
      <button type="button" onClick={copy} className={linkClass}>
        {copied ? (
          <Check className="h-4 w-4 text-success" aria-hidden="true" />
        ) : (
          <Link2 className="h-4 w-4" aria-hidden="true" />
        )}
        {copied ? "Link copied" : "Copy link"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Product card                                                        */
/* ------------------------------------------------------------------ */

function ReleaseCard({
  release,
  live,
}: {
  release: LaunchRelease;
  live: boolean;
}) {
  const links = shareUrls(`${LAUNCH_PAGE_URL}/${release.slug}`);
  return (
    <div className="group relative overflow-hidden rounded-2xl border bg-card p-8">
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute -top-16 -right-16 h-48 w-48 rounded-full blur-3xl ${release.glowClass}`}
      />
      <div className="relative">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2 w-2" aria-hidden="true">
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${release.dotClass}`}
            />
            <span
              className={`relative inline-flex h-2 w-2 rounded-full ${release.dotClass}`}
            />
          </span>
          <span className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
            {live ? "Live now" : "Launching"}
          </span>
        </div>

        <h3 className="mt-5 text-2xl font-semibold tracking-tight text-foreground">
          {release.name}
        </h3>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {release.tagline}
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
          <Link
            href={release.href}
            className="inline-flex items-center gap-1 text-sm font-medium text-foreground underline-offset-4 hover:underline"
          >
            {live ? `Explore ${release.name}` : "Learn more"}
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
          <span className="flex items-center gap-3 text-muted-foreground">
            <a
              href={links.facebook}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Share the ${release.name} launch on Facebook`}
              className="transition-colors hover:text-foreground"
            >
              <Facebook className="h-4 w-4" aria-hidden="true" />
            </a>
            <a
              href={links.linkedin}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Share the ${release.name} launch on LinkedIn`}
              className="transition-colors hover:text-foreground"
            >
              <Linkedin className="h-4 w-4" aria-hidden="true" />
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One launch event (a group of releases sharing an instant)           */
/* ------------------------------------------------------------------ */

function localTimeLabel(targetIso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(targetIso));
}

function LaunchEvent({
  group,
  hero,
  shareUrl,
}: {
  group: LaunchGroup;
  hero: boolean;
  shareUrl: string;
}) {
  const targetMs = Date.parse(group.targetIso);
  const secondsLeft = useSecondsLeft(targetMs);
  const { soundOn, toggle } = useTickTock(secondsLeft);
  const [localTime, setLocalTime] = useState<string | null>(null);
  const live = secondsLeft === 0;
  const single = group.releases.length === 1;

  useEffect(() => {
    setLocalTime(localTimeLabel(group.targetIso));
  }, [group.targetIso]);

  const names = group.releases.map((release) => release.name);
  const nameList =
    names.length > 1
      ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
      : names[0];

  return (
    <section className="relative mx-auto max-w-5xl px-6 py-16 sm:py-20 lg:px-8">
      <div className="text-center">
        <p className="inline-flex items-center gap-2.5 rounded-full border bg-card/60 px-4 py-1.5 font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground backdrop-blur">
          <span className="relative flex h-2 w-2" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
          </span>
          {live ? "Launch day is here" : "Launch day"}
        </p>

        {hero ? (
          <h1 className="mt-8 text-4xl font-semibold tracking-tight text-foreground sm:text-6xl">
            {live ? (
              <>
                {nameList} {names.length > 1 ? "are" : "is"} live.
              </>
            ) : single ? (
              <>{nameList} launches this Saturday.</>
            ) : (
              <>
                {["Two", "Three", "Four", "Five"][names.length - 2] ??
                  names.length}{" "}
                launches.
                <br />
                <span className="text-muted-foreground">One Saturday.</span>
              </>
            )}
          </h1>
        ) : (
          <h2 className="mt-8 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            {nameList}
          </h2>
        )}

        <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
          {live ? (
            <>Doors are open — come and have a look around.</>
          ) : (
            <>
              {nameList} open{names.length > 1 ? "" : "s"} to everyone on{" "}
              <span className="font-medium whitespace-nowrap text-foreground">
                {group.displayDate}
              </span>
              .
            </>
          )}
        </p>
        {!live && localTime && (
          <p className="mt-2 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Your local time · {localTime}
          </p>
        )}
      </div>

      <div className="mt-14 sm:mt-16">
        {live ? (
          <p className="text-center font-mono text-5xl font-medium tracking-tight text-foreground sm:text-7xl">
            00:00:00
          </p>
        ) : (
          <Countdown secondsLeft={secondsLeft} size={hero ? "hero" : "compact"} />
        )}
      </div>

      {!live && (
        <div className="mt-10 flex justify-center">
          <button
            type="button"
            onClick={toggle}
            aria-pressed={soundOn}
            className="inline-flex items-center gap-2 rounded-full border bg-card px-4 py-2 text-xs font-medium uppercase tracking-[0.15em] text-muted-foreground transition-colors hover:text-foreground"
          >
            {soundOn ? (
              <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {soundOn ? "Tick-tock on" : "Tick-tock off"}
          </button>
        </div>
      )}

      <div
        className={`mt-14 grid gap-6 sm:mt-16 ${
          single ? "mx-auto max-w-md" : "sm:grid-cols-2"
        }`}
      >
        {group.releases.map((release) => (
          <ReleaseCard key={release.slug} release={release} live={live} />
        ))}
      </div>

      <div className="mt-14 sm:mt-16">
        <p className="mb-4 text-center font-mono text-xs font-medium uppercase tracking-[0.25em] text-muted-foreground">
          Spread the word
        </p>
        <ShareRow url={shareUrl} />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Page content                                                        */
/* ------------------------------------------------------------------ */

export function LaunchContent({
  releases,
  shareUrl = LAUNCH_PAGE_URL,
}: {
  releases: readonly LaunchRelease[];
  shareUrl?: string;
}) {
  const groups = groupReleasesByTarget(releases);

  return (
    <div className="relative overflow-hidden bg-background">
      {/* Same quiet dot-grid texture as the homepage hero, for cohesion */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:radial-gradient(ellipse_75%_75%_at_50%_-10%,black,transparent)]"
      />
      <div className="relative divide-y">
        {groups.map((group, i) => (
          <LaunchEvent
            key={group.targetIso}
            group={group}
            hero={i === 0}
            shareUrl={shareUrl}
          />
        ))}
      </div>

      {releases.length < 2 && (
        <div className="relative border-t py-10 text-center">
          <Link
            href="/launch"
            className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            See everything launching →
          </Link>
        </div>
      )}
    </div>
  );
}
