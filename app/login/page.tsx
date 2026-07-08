type LoginPageProps = {
  searchParams: Promise<{ error?: string }>;
};

function LoginTrustIcon({ name }: { name: "shield" | "user" | "check" | "lock" }) {
  const shared = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };

  if (name === "shield") {
    return (
      <svg {...shared}>
        <path d="M12 3 5 6v5c0 4.3 2.8 8.2 7 10 4.2-1.8 7-5.7 7-10V6l-7-3Z" />
        <path d="m9 12 2 2 4-5" />
      </svg>
    );
  }

  if (name === "user") {
    return (
      <svg {...shared}>
        <circle cx="12" cy="8" r="3.2" />
        <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
      </svg>
    );
  }

  if (name === "check") {
    return (
      <svg {...shared}>
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12.2 2.2 2.2 4.8-5.1" />
      </svg>
    );
  }

  return (
    <svg {...shared}>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

const trustItems = [
  {
    icon: "shield" as const,
    title: "Your password stays with Steam",
    text: "Vault Shuffle never sees or stores your password."
  },
  {
    icon: "user" as const,
    title: "We only receive your SteamID",
    text: "Used to sync your library, wishlist, playtime and game details."
  },
  {
    icon: "check" as const,
    title: "Your session is remembered",
    text: "This browser can open the app directly next time."
  },
  {
    icon: "lock" as const,
    title: "Private, secure, transparent",
    text: "Your data stays under your control."
  }
];

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error } = await searchParams;

  return (
    <>
      <link rel="stylesheet" href="/landing.css" />

      <main className="steam-login-page trust-login-page">
        <section className="trust-login-copy" aria-labelledby="login-title">
          <a className="trust-login-brand" href="/" aria-label="Vault Shuffle home">
            <img src="/assets/landing/vaultshuffle-logo-real.png" alt="" />
            <span>
              Vault <strong>Shuffle</strong>
            </span>
          </a>

          <div className="trust-login-heading">
            <p className="trust-login-kicker">One quick check before the vault opens</p>

            <h1 id="login-title">
              Sign in with <span>Steam</span>
            </h1>

            <p>
              We use Steam sign-in to recognise your account and keep your games in sync. Here&apos;s exactly what happens.
            </p>
          </div>

          <div className="trust-login-benefits" aria-label="What Steam sign-in does">
            {trustItems.map((item) => (
              <article className="trust-login-benefit" key={item.title}>
                <span className="trust-login-benefit-icon">
                  <LoginTrustIcon name={item.icon} />
                </span>

                <span>
                  <strong>{item.title}</strong>
                  <small>{item.text}</small>
                </span>
              </article>
            ))}
          </div>

          {error ? <p className="trust-login-error">{error}</p> : null}

          <a className="trust-steam-button" href="/api/auth/steam" aria-label="Sign in through Steam">
            <span className="trust-steam-mark" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="15.7" cy="8.4" r="2.6" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="8.2" cy="15.7" r="2.2" stroke="currentColor" strokeWidth="1.8" />
                <path d="m10 14.5 3.8-4.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="m5.9 14.6 2.4 1.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </span>

            <strong>Sign in with Steam</strong>
            <span aria-hidden="true">→</span>
          </a>

          <p className="trust-login-footnote">
            Secure. Private. Built for players.
          </p>

          <a className="trust-back-link" href="/">
            ← Back to home
          </a>
        </section>

        <section className="trust-login-vault" aria-hidden="true">
          <div className="trust-login-vault-frame" />
          <div className="trust-login-vault-glow" />
        </section>
      </main>
    </>
  );
}
