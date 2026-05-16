import type { SVGProps } from "react";

export type FrogMood = "pro" | "con" | "judge" | "idle";

interface FrogProps extends SVGProps<SVGSVGElement> {
  mood?: FrogMood;
  /** Toggle a small wink for "talking" turns */
  speaking?: boolean;
  size?: number;
}

const palette: Record<FrogMood, { body: string; belly: string; cheek: string; mouth: string }> = {
  pro: { body: "#44a15f", belly: "#dff5dc", cheek: "#9be1ad", mouth: "#0d4f45" },
  con: { body: "#d45f7a", belly: "#fde2ea", cheek: "#f4b4c4", mouth: "#7a2a3d" },
  judge: { body: "#9978b8", belly: "#ece4f5", cheek: "#c8b8dd", mouth: "#3f2f55" },
  idle: { body: "#7fc99a", belly: "#e7f5e0", cheek: "#b9e0c5", mouth: "#1a4836" }
};

export function Frog({ mood = "idle", speaking = false, size = 72, ...rest }: FrogProps) {
  const c = palette[mood];
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      {/* feet */}
      <ellipse cx="28" cy="86" rx="14" ry="6" fill={c.body} />
      <ellipse cx="72" cy="86" rx="14" ry="6" fill={c.body} />
      {/* body */}
      <ellipse cx="50" cy="64" rx="34" ry="26" fill={c.body} />
      {/* belly */}
      <ellipse cx="50" cy="70" rx="22" ry="15" fill={c.belly} />
      {/* head */}
      <ellipse cx="50" cy="42" rx="32" ry="24" fill={c.body} />
      {/* eye whites (poking up like lily pad) */}
      <circle cx="34" cy="24" r="10" fill={c.body} />
      <circle cx="66" cy="24" r="10" fill={c.body} />
      <circle cx="34" cy="22" r="8" fill="#ffffff" />
      <circle cx="66" cy="22" r="8" fill="#ffffff" />
      {/* pupils */}
      {speaking ? (
        <>
          {/* winking left eye */}
          <path d="M28 22 q6 -3 12 0" stroke="#1a1a1a" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <circle cx="66" cy="22" r="3.2" fill="#1a1a1a" />
          <circle cx="67" cy="21" r="1.1" fill="#ffffff" />
        </>
      ) : (
        <>
          <circle cx="34" cy="22" r="3.2" fill="#1a1a1a" />
          <circle cx="66" cy="22" r="3.2" fill="#1a1a1a" />
          <circle cx="35" cy="21" r="1.1" fill="#ffffff" />
          <circle cx="67" cy="21" r="1.1" fill="#ffffff" />
        </>
      )}
      {/* cheeks */}
      <circle cx="26" cy="46" r="4" fill={c.cheek} opacity="0.7" />
      <circle cx="74" cy="46" r="4" fill={c.cheek} opacity="0.7" />
      {/* mouth */}
      {mood === "judge" ? (
        // judge: small straight line, considering
        <path d="M40 50 L60 50" stroke={c.mouth} strokeWidth="2.5" strokeLinecap="round" fill="none" />
      ) : mood === "con" ? (
        // con: serious frown
        <path d="M40 54 q10 -8 20 0" stroke={c.mouth} strokeWidth="2.5" strokeLinecap="round" fill="none" />
      ) : (
        // pro / idle: friendly smile
        <path d="M40 48 q10 10 20 0" stroke={c.mouth} strokeWidth="2.5" strokeLinecap="round" fill="none" />
      )}
    </svg>
  );
}
