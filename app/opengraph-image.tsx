import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt = "VaultShuffle — pick the right Steam game for tonight";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  const logoData = await readFile(join(process.cwd(), "app/icon.png"), "base64");
  const logoSrc = `data:image/png;base64,${logoData}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          overflow: "hidden",
          padding: "68px 76px",
          color: "#fff",
          background:
            "radial-gradient(circle at 80% 20%, #7038d8 0%, #24124f 24%, transparent 49%), linear-gradient(145deg, #080b1f 0%, #0c0f2a 52%, #170c38 100%)"
        }}
      >
        <div
          style={{
            position: "absolute",
            right: "-85px",
            bottom: "-120px",
            width: "540px",
            height: "540px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "3px solid rgba(204, 136, 255, 0.34)",
            borderRadius: "50%",
            boxShadow: "0 0 90px rgba(151, 71, 255, 0.38), inset 0 0 70px rgba(78, 45, 190, 0.28)"
          }}
        >
          <div
            style={{
              width: "360px",
              height: "360px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "50%"
            }}
          >
            <img src={logoSrc} width={360} height={360} alt="" />
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", width: "780px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "15px", fontSize: "27px", fontWeight: 850 }}>
            <img src={logoSrc} width={45} height={45} alt="" />
            VaultShuffle
          </div>

          <div
            style={{
              display: "flex",
              marginTop: "68px",
              color: "#d99aff",
              fontSize: "20px",
              fontWeight: 800,
              letterSpacing: "4px",
              textTransform: "uppercase"
            }}
          >
            Free Steam game picker
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              marginTop: "16px",
              fontSize: "64px",
              fontWeight: 900,
              lineHeight: 1.04,
              letterSpacing: "-3px"
            }}
          >
            <div style={{ display: "flex" }}>Stop scrolling.</div>
            <div style={{ display: "flex", color: "#cf83ff" }}>Pick the right game tonight.</div>
          </div>

          <div style={{ display: "flex", marginTop: "32px", color: "rgba(238, 232, 255, 0.75)", fontSize: "25px" }}>
            Time · Mood · Goal · Your Steam library
          </div>
        </div>
      </div>
    ),
    size
  );
}
