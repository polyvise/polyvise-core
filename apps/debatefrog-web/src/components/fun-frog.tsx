import type { SVGProps } from "react";

/**
 * FunFrog — animated SVG frog used by DebateFrog.
 *
 * Adds:
 *
 *   - idle bob (vertical sway)
 *   - idle blink (eyes briefly snap shut every few seconds)
 *   - mouth chatter keyed to the `speaking` prop
 *   - one-shot hop when `hop` is true (e.g. when a frog "takes the floor")
 *
 * All animations honor `prefers-reduced-motion` via globals.css.
 */

export type FunFrogMood = "pro" | "con" | "judge" | "idle";

interface FunFrogProps extends SVGProps<SVGSVGElement> {
  mood?: FunFrogMood;
  /** When true, the mouth chatters open and closed. */
  speaking?: boolean;
  /** When true, plays a one-shot hop animation. */
  hop?: boolean;
  /** When true, plays the idle bob loop. Defaults to true. */
  bob?: boolean;
  size?: number;
}

const palette: Record<FunFrogMood, { body: string; belly: string; cheek: string; mouth: string }> = {
  pro:   { body: "#44a15f", belly: "#dff5dc", cheek: "#9be1ad", mouth: "#0d4f45" },
  con:   { body: "#d45f7a", belly: "#fde2ea", cheek: "#f4b4c4", mouth: "#7a2a3d" },
  judge: { body: "#9978b8", belly: "#ece4f5", cheek: "#c8b8dd", mouth: "#3f2f55" },
  idle:  { body: "#7fc99a", belly: "#e7f5e0", cheek: "#b9e0c5", mouth: "#1a4836" }
};

export function FunFrog({
  mood = "idle",
  speaking = false,
  hop = false,
  bob = true,
  size = 72,
  className,
  ...rest
}: FunFrogProps) {
  const c = palette[mood];

  // Compose the outer animation classes. The hop is one-shot and takes
  // precedence over the bob loop while it plays.
  const motionClass = hop ? "fun-frog-hop" : bob ? "fun-frog-bob" : "";
  const composed = [motionClass, className].filter(Boolean).join(" ");

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={composed || undefined}
      {...rest}
    >
      {/* feet */}
      <ellipse cx="28" cy="86" rx="14" ry="6" fill={c.body} />
      <ellipse cx="72" cy="86" rx="14" ry="6" fill={c.body} />
      {/* body */}
      <ellipse cx="50" cy="64" rx="34" ry="26" fill={c.body} />
      {/* belly */}
      <ellipse cx="50" cy="70" rx="22" ry="15" fill={c.belly} />
      {mood === "judge" ? (
        <>
          {/* robe and collar */}
          <path d="M31 57 q19 13 38 0 v27 q-19 8 -38 0z" fill="#352641" opacity="0.88" />
          <path d="M39 56 l11 12 l11 -12 l-6 25 h-10z" fill="#fffdf2" opacity="0.95" />
          <path d="M50 68 v19" stroke="#5c4583" strokeWidth="2" strokeLinecap="round" opacity="0.75" />
        </>
      ) : null}
      {/* head */}
      <ellipse cx="50" cy="42" rx="32" ry="24" fill={c.body} />
      {mood === "judge" ? (
        <>
          {/* small judge's wig */}
          <path d="M31 26 q19 -15 38 0 q-5 6 -12 5 q-7 -4 -14 0 q-7 1 -12 -5z" fill="#fffdf2" />
          <circle cx="31" cy="31" r="5" fill="#fffdf2" />
          <circle cx="69" cy="31" r="5" fill="#fffdf2" />
        </>
      ) : null}
      {/* eye whites poking up like lily pads */}
      <circle cx="34" cy="24" r="10" fill={c.body} />
      <circle cx="66" cy="24" r="10" fill={c.body} />

      {/*
        Eyes — wrapped in groups so each one blinks on its own animation
        instance. The transform-origin via the CSS class makes the scale
        collapse vertically (eyes closing) rather than shrinking from the
        corner.
      */}
      <g className="fun-frog-eye" style={{ transformOrigin: "34px 22px" }}>
        <circle cx="34" cy="22" r="8" fill="#ffffff" />
        <circle cx="34" cy="22" r="3.2" fill="#1a1a1a" />
        <circle cx="35" cy="21" r="1.1" fill="#ffffff" />
      </g>
      <g
        className="fun-frog-eye"
        style={{ transformOrigin: "66px 22px", animationDelay: "0.2s" }}
      >
        <circle cx="66" cy="22" r="8" fill="#ffffff" />
        <circle cx="66" cy="22" r="3.2" fill="#1a1a1a" />
        <circle cx="67" cy="21" r="1.1" fill="#ffffff" />
      </g>

      {/* cheeks */}
      <circle cx="26" cy="46" r="4" fill={c.cheek} opacity="0.7" />
      <circle cx="74" cy="46" r="4" fill={c.cheek} opacity="0.7" />

      {/*
        Mouth — different resting shape per mood. While `speaking` is true
        the mouth group scaleY-chatters, which gives a satisfying "talking"
        effect on top of any mood shape.
      */}
      <g
        className={`fun-frog-mouth${speaking ? " is-speaking" : ""}`}
        style={{ transformOrigin: "50px 52px" }}
      >
        {mood === "judge" ? (
          <path d="M40 50 L60 50" stroke={c.mouth} strokeWidth="2.5" strokeLinecap="round" fill="none" />
        ) : mood === "con" ? (
          <path d="M40 54 q10 -8 20 0" stroke={c.mouth} strokeWidth="2.5" strokeLinecap="round" fill="none" />
        ) : (
          <path d="M40 48 q10 10 20 0" stroke={c.mouth} strokeWidth="2.5" strokeLinecap="round" fill="none" />
        )}
      </g>
    </svg>
  );
}
