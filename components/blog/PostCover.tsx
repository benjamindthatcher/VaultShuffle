import Image from "next/image";
import type { PostBanner } from "@/lib/blog/posts";
import styles from "./PostCover.module.css";

/** Shared artwork connects the index invitation to the article it opens. */
export function PostCover({ banner, layout = "strip", eager = false }: {
  banner: PostBanner;
  layout?: "feature" | "strip";
  eager?: boolean;
}) {
  return (
    <div className={`${styles.cover} ${styles[layout]}`}>
      {banner.kind === "image" ? (
        <Image
          className={styles.image}
          src={banner.src}
          alt={banner.alt ?? ""}
          fill
          sizes="(max-width: 1120px) 100vw, 1040px"
          loading={eager ? "eager" : "lazy"}
        />
      ) : banner.appids.map((appid) => (
        <Image
          key={appid}
          className={styles.tile}
          src={`https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`}
          alt=""
          width={460}
          height={215}
          loading={eager ? "eager" : "lazy"}
          unoptimized
        />
      ))}
      <span className={styles.shade} aria-hidden="true" />
    </div>
  );
}
