import { SiteFooter, SiteNav } from "@/components/SiteNav";

type Panel = {
  title: string;
  body: string;
};

export function ContentPage({ title, intro, panels }: { title: string; intro: string; panels: Panel[] }) {
  return (
    <>
      <link rel="stylesheet" href="/landing.css" />
      <SiteNav />
      <main className="page-main">
        <section className="page-hero">
          <h1>{title}</h1>
          <p>{intro}</p>
        </section>
        <section className={panels.length > 3 ? "content-grid" : undefined}>
          {panels.map((panel) => (
            <article className="content-panel" key={panel.title}>
              <h2>{panel.title}</h2>
              <p>{panel.body}</p>
            </article>
          ))}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
