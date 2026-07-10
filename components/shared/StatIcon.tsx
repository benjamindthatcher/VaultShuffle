type StatIconProps = {
  label: string;
};

export function StatIcon({ label }: StatIconProps) {
  const key = label.toLowerCase();

  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {iconPaths(key)}
    </svg>
  );
}

function iconPaths(key: string) {
  if (key.includes("played")) return <><circle cx="12" cy="12" r="8" /><path d="m10 8 6 4-6 4V8Z" /></>;
  if (key.includes("backlog")) return <><path d="M7 4.5h10v15l-5-3-5 3v-15Z" /></>;
  if (key.includes("completed")) return <><circle cx="12" cy="12" r="8" /><path d="m8.5 12 2.2 2.2 4.8-5" /></>;
  if (key.includes("progress") || key.includes("paused")) return <><circle cx="12" cy="12" r="8" /><path d="M10 9v6M14 9v6" /></>;
  if (key.includes("wishlist")) return <path d="M12 20S4.5 15.7 4.5 9.5A4 4 0 0 1 12 7.3a4 4 0 0 1 7.5 2.2C19.5 15.7 12 20 12 20Z" />;
  if (key.includes("sale")) return <><path d="M4.5 12.5 12 5h6.5v6.5L11 19l-6.5-6.5Z" /><circle cx="15.5" cy="8.5" r="1" /></>;
  if (key.includes("in library")) return <><path d="m12 3 7 4v10l-7 4-7-4V7l7-4Z" /><path d="m5 7 7 4 7-4M12 11v10" /></>;
  if (key.includes("library")) return <><path d="M5 5h5v14H5zM14 5h5v14h-5z" /><path d="M7.5 8h0M16.5 8h0" /></>;
  if (key.includes("following")) return <><circle cx="9" cy="9" r="3" /><path d="M3.5 19c.7-3 2.5-4.5 5.5-4.5s4.8 1.5 5.5 4.5" /><path d="M16 8h5M18.5 5.5v5" /></>;
  if (key.includes("smart")) return <><path d="m12 3 1.2 4.1L17 9l-3.8 1.9L12 15l-1.2-4.1L7 9l3.8-1.9L12 3Z" /><path d="m18.5 14 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" /></>;
  if (key.includes("custom")) return <><path d="m5 17 1.2-4.2L15.8 3.2a1.7 1.7 0 0 1 2.4 0l.6.6a1.7 1.7 0 0 1 0 2.4l-9.6 9.6L5 17Z" /><path d="m14.5 4.5 5 5" /></>;
  if (key.includes("games in collections")) return <><path d="M7.5 9h9a4 4 0 0 1 3.8 5.2l-1 3a2 2 0 0 1-3.2 1l-2.1-1.7h-4l-2.1 1.7a2 2 0 0 1-3.2-1l-1-3A4 4 0 0 1 7.5 9Z" /><path d="M8 12v3M6.5 13.5h3M15.5 13h.01M18 15h.01" /></>;
  if (key.includes("collections")) return <><rect x="4" y="6" width="16" height="14" rx="2" /><path d="M8 6V4h8v2M8 11h8M8 15h5" /></>;
  return <><path d="M7.5 9h9a4 4 0 0 1 3.8 5.2l-1 3a2 2 0 0 1-3.2 1l-2.1-1.7h-4l-2.1 1.7a2 2 0 0 1-3.2-1l-1-3A4 4 0 0 1 7.5 9Z" /><path d="M8 12v3M6.5 13.5h3M15.5 13h.01M18 15h.01" /></>;
}
