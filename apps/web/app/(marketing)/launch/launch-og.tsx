import { ImageResponse } from "next/og";
import type { LaunchRelease } from "./launch-config";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

// Shared 1200×630 card used by /launch and /launch/[slug] — dark ink
// background so the card stands out in white social feeds, one thin accent
// stripe per product along the bottom edge.
export function renderLaunchOg({
  title,
  subtitle,
  displayDate,
  releases,
}: {
  title: string;
  subtitle: string;
  displayDate: string;
  releases: readonly LaunchRelease[];
}) {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#0f172a",
          backgroundImage:
            "radial-gradient(circle at 25px 25px, #1e293b 2%, transparent 0%), radial-gradient(circle at 75px 75px, #1e293b 2%, transparent 0%)",
          backgroundSize: "100px 100px",
          padding: "72px 80px",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
        >
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: 999,
              backgroundColor: "#22c55e",
            }}
          />
          <div
            style={{
              fontSize: 26,
              letterSpacing: 8,
              color: "#94a3b8",
              textTransform: "uppercase",
            }}
          >
            Tesserix · Launch day
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div
            style={{
              fontSize: 92,
              fontWeight: 700,
              letterSpacing: -3,
              lineHeight: 1.05,
              color: "#ffffff",
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 32,
              lineHeight: 1.4,
              color: "#94a3b8",
              maxWidth: 900,
            }}
          >
            {subtitle}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              border: "2px solid #334155",
              borderRadius: 999,
              padding: "16px 32px",
              fontSize: 30,
              letterSpacing: 2,
              color: "#e2e8f0",
            }}
          >
            {displayDate}
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            {releases.map((release) => (
              <div
                key={release.slug}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 26,
                  color: "#cbd5e1",
                }}
              >
                <div
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 999,
                    backgroundColor: release.accentHex,
                  }}
                />
                {release.name}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    OG_SIZE,
  );
}
