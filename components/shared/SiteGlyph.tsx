import type { CSSProperties, ReactNode } from "react";

type SiteGlyphProps = {
  name: string;
  size?: number;
  className?: string;
  title?: string;
  style?: CSSProperties;
};

const P = (d: string) => <path d={d} />;

function glyph(name: string): ReactNode {
  switch (name) {
    case "chevron-left": return P("m14.5 6-6 6 6 6");
    case "chevron-right": return P("m9.5 6 6 6-6 6");
    case "chevron-up": return P("m6 15 6-6 6 6");
    case "chevron-down": return P("m6 9 6 6 6-6");
    case "back": return <><path d="M19 12H5m6-6-6 6 6 6" /></>;
    case "close": return P("M6 6l12 12M18 6 6 18");
    case "check": return P("m5 12 4 4L19 6");
    case "add": return P("M12 5v14M5 12h14");
    case "menu-dots": return <><circle cx="5" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.25" fill="currentColor" stroke="none"/></>;
    case "search": return <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/></>;
    case "filter": case "clear-filters": return <><path d="M4 5h16l-6.3 7.1v5.2l-3.4 1.7v-6.9L4 5Z"/>{name === "clear-filters" && <path d="m16 16 4 4m0-4-4 4"/>}</>;
    case "sort": return <><path d="M8 5v14m0 0-3-3m3 3 3-3M16 19V5m0 0-3 3m3-3 3 3"/></>;
    case "grid": return <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>;
    case "list": return <><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="5" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="18" r="1" fill="currentColor" stroke="none"/></>;
    case "external-link": return <><path d="M14 5h5v5M19 5l-8 8"/><path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></>;
    case "clock": case "recent": return <><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.5 2"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></>;
    case "playtime": return <><path d="M5 7h14v10H5V7Z"/><path d="m10 10 5 2-5 2v-4ZM8 4h8"/></>;
    case "calendar": return <><rect x="4" y="5.5" width="16" height="14" rx="2.5"/><path d="M8 3v5M16 3v5M4 10h16M8 14h2m3 0h3m-8 3h2"/></>;
    case "weekend-session": return <><rect x="4" y="5.5" width="16" height="14" rx="2.5"/><path d="M8 3v5M16 3v5M4 10h16"/><path d="m12 13 .8 1.6 1.8.3-1.3 1.2.3 1.8-1.6-.8-1.6.8.3-1.8-1.3-1.2 1.8-.3.8-1.6Z"/></>;
    case "session": return <><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v3M20.5 12h-3M12 20.5v-3M3.5 12h3"/><path d="m12 12 3-3"/></>;
    case "short-session": return <><path d="M7 3h10M7 21h10M8 3c0 4 1.6 5.5 4 7 2.4-1.5 4-3 4-7M8 21c0-4 1.6-5.5 4-7 2.4 1.5 4 3 4 7"/><path d="M9 18h6"/></>;
    case "evening-session": return <><path d="M18 15.5A7.5 7.5 0 0 1 8.5 6a7.5 7.5 0 1 0 9.5 9.5Z"/><path d="m17 5 .5 1.5L19 7l-1.5.5L17 9l-.5-1.5L15 7l1.5-.5L17 5Z"/></>;
    case "mood": return <><circle cx="12" cy="12" r="8.5"/><path d="M8.5 14.5c1.8 2 5.2 2 7 0M9 9.5h.01M15 9.5h.01"/></>;
    case "brain-off": return <><path d="M9 19H7.8A3.8 3.8 0 0 1 5 12.6a4 4 0 0 1 2.3-6.9A4 4 0 0 1 14.8 6 3.5 3.5 0 0 1 18 11.7 3.8 3.8 0 0 1 15.5 19H14"/><path d="M9 8v3m6-3v3M12 5v14"/><path d="m10 16 2 3 2-3"/></>;
    case "chill": return <><path d="M5 12h14v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-5Z"/><path d="M7 12V8a3 3 0 0 1 6 0v4m0-2a3 3 0 0 1 6 0v2M8 4.5 7 3M12 4l1-2"/></>;
    case "intense": return P("M13 2 5.5 13H11l-1 9 8.5-12H13l0-8Z");
    case "goal": case "target": return <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="m14 10 5-5M15 5h4v4"/></>;
    case "something-new": return <><circle cx="10" cy="13" r="7"/><path d="m14.5 8.5 4.5-4.5M16 4h3v3"/><path d="M8 13h4m-2-2v4"/></>;
    case "finish": return <><path d="M5 20V5m0 1h11l-2 3 2 3H5"/><path d="M9 16h8"/></>;
    case "finish-something": return <><path d="M5 19c3-8 7-12 14-14"/><path d="M6 12h4v4h4v-4h4"/><circle cx="19" cy="5" r="2"/></>;
    case "completed": return <><circle cx="12" cy="12" r="8.5"/><path d="m8 12 2.5 2.5L16.5 8"/></>;
    case "mark-completed": return <><path d="M5 4h10l4 4v12H5V4Z"/><path d="M15 4v5h5m-11 5 2 2 4-5"/></>;
    case "surprise": case "surprise-me": return <><path d="M4 9h16v11H4V9Z"/><path d="M12 9v11M3 9h18M12 9c-4 0-5.5-1.1-5.5-3 0-1.4 1.1-2.5 2.5-2.5 2.2 0 3 2.7 3 5.5Zm0 0c4 0 5.5-1.1 5.5-3 0-1.4-1.1-2.5-2.5-2.5-2.2 0-3 2.7-3 5.5Z"/></>;
    case "new": return <><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z"/><path d="m18 16 .6 2.4L21 19l-2.4.6L18 22l-.6-2.4L15 19l2.4-.6L18 16Z"/></>;
    case "all-games": case "library": return <><path d="M4.5 10.5h15l-1.2 8a2 2 0 0 1-2 1.7H7.7a2 2 0 0 1-2-1.7l-1.2-8Z"/><path d="M7 10.5 8.5 6h7l1.5 4.5M8 15h3m-1.5-1.5v3M15.5 14.2h.01M17 16h.01"/></>;
    case "played": return <><circle cx="12" cy="12" r="8.5"/><path d="m10 8 6 4-6 4V8Z"/></>;
    case "backlog": return <><rect x="4" y="7" width="16" height="12" rx="2"/><path d="M7 4h10v3M8 11h8m-8 4h5"/></>;
    case "in-library": return <><path d="M5 4h14v16H5V4Z"/><path d="M9 4v16m3-11h4m-4 4h4"/></>;
    case "in-progress": return <><circle cx="12" cy="12" r="8.5"/><path d="m10 8 6 4-6 4V8Z"/><path d="M12 3.5v2"/></>;
    case "paused": return <><circle cx="12" cy="12" r="8.5"/><path d="M9.5 8.5v7M14.5 8.5v7"/></>;
    case "collections": case "books": return <><rect x="4" y="4" width="4.5" height="16" rx="1"/><rect x="9.75" y="4" width="4.5" height="16" rx="1"/><path d="m16 5 3 14"/></>;
    case "all-collections": return <><rect x="3" y="5" width="7" height="14" rx="1"/><rect x="12" y="5" width="9" height="6" rx="1"/><rect x="12" y="13" width="9" height="6" rx="1"/></>;
    case "games-in-collections": return <><path d="M4 6h7v12H4V6Zm9 0h7v12h-7V6Z"/><path d="m7 10 2 2-2 2m9-4 2 2-2 2"/></>;
    case "layers": return <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5m-18 8 9 5 9-5"/></>;
    case "smart-collections": return <><path d="M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 2.8A3.2 3.2 0 0 0 6 14v1a3 3 0 0 0 3 3M15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 2 2.8 3.2 3.2 0 0 1-2 3.2v1a3 3 0 0 1-3 3M12 3v18M9 8h3m3 4h-3m-3 4h3"/></>;
    case "custom-collections": return <><rect x="4" y="5" width="16" height="14" rx="2"/><path d="m9 15 6-6 2 2-6 6H9v-2Z"/></>;
    case "edit": return <><path d="M5 19h4l10-10-4-4L5 15v4Z"/><path d="m13 7 4 4M4 21h16"/></>;
    case "note": return <><path d="M5 4h14v16H5V4Z"/><path d="M8 8h8m-8 4h8m-8 4h5"/></>;
    case "wishlist": case "heart": return P("M12 20S4 15.5 4 9.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 8 3.5C20 15.5 12 20 12 20Z");
    case "on-sale": case "price": return <><path d="M4 5h9l7 7-8 8-8-8V5Z"/><circle cx="8" cy="9" r="1.2"/><path d="m10 15 5-5m-4 1h.01m4 4h.01"/></>;
    case "following": return <><path d="M7 4h10v16l-5-3-5 3V4Z"/><path d="M10 9h4"/></>;
    case "pin": return <><path d="m9 4 6 2-1 5 3 3-4 1-2 5-1-5-4-2 3-3V4Z"/><path d="m12 3 1 2"/></>;
    case "manage-pins": return <><path d="m7 4 4 2-1 4 2 2-3 1-1 4-1-4-3-1 2-2V4Zm10 2 3 1.5-1 3 2 2-3 .5-1 4-1-4-3-.5 2-2V6Z"/></>;
    case "unpin": return <><path d="m9 4 6 2-1 5 3 3-4 1-2 5-1-5-4-2 3-3V4Z"/><path d="M4 4l16 16"/></>;
    case "action": return P("M13 2 6 13h5l-1 9 8-12h-5V2Z");
    case "genre": return <path d="M4 6h7v5H4V6Zm9 0h7v5h-7V6ZM4 13h7v5H4v-5Zm9 0h7v5h-7v-5Z"/>;
    case "adventure": case "exploration": return <><circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z"/></>;
    case "casual": case "cozy": return <><circle cx="12" cy="12" r="8.5"/><path d="M8.5 14.5c1.8 2 5.2 2 7 0M9 9h.01M15 9h.01"/></>;
    case "indie": case "star": return P("m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z");
    case "racing": return <><path d="M5 20V5m0 1c5-3 7 3 14 0v9c-7 3-9-3-14 0"/><path d="M9 5v10m5-9v10"/></>;
    case "rpg": case "fantasy": return <><path d="m12 3 6 3v6c0 4-2.5 7-6 9-3.5-2-6-5-6-9V6l6-3Z"/><path d="m9 8 6 6m0-6-6 6"/></>;
    case "simulation": case "sim": return <><circle cx="12" cy="12" r="3"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1"/></>;
    case "sports": return <><circle cx="12" cy="12" r="8.5"/><path d="m8 5.5 4 3 4-3M6 15l4-1 2-5.5 2 5.5 4 1M10 14v6m4-6v6"/></>;
    case "strategy": return <><path d="M7 3h10M8 3v5l2 3-4 9h12l-4-9 2-3V3"/><path d="M9 15h6"/></>;
    case "sci-fi": case "space": return <><circle cx="12" cy="12" r="3"/><path d="M4 14c-2-2 1-5 6-7s9-2 10 0-2 5-7 7-8 2-9 0Z"/><path d="M8 4c2-2 5 1 7 6s2 9 0 10-5-2-7-7-2-8 0-9Z"/></>;
    case "horror": case "dark-fantasy": return <><path d="M5 12a7 7 0 1 1 14 0v7l-3-2-2 2-2-2-2 2-2-2-3 2v-7Z"/><path d="M9 11h.01M15 11h.01M10 14h4"/></>;
    case "narrative": case "story": case "story-rich": case "story-rich-genre": return <><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z"/><path d="M8 4v16M11 8h5m-5 4h5"/></>;
    case "open-world": case "open-worlds": case "open_w": return <><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c3 3 3 14 0 17m0-17c-3 3-3 14 0 17"/></>;
    case "roguelike": case "souls-like": case "soulslike": return <><path d="M12 3 5 7v5c0 4 3 7 7 9 4-2 7-5 7-9V7l-7-4Z"/><path d="M9 10h.01M15 10h.01m-5 5h4M12 12v2"/></>;
    case "platformer": case "platform": return <><path d="M4 18h6v-4h5v-4h5"/><circle cx="7" cy="8" r="2.5"/><path d="m6 5 1-2 1 2"/></>;
    case "puzzle": return <><path d="M4 5h6a2 2 0 1 1 4 0h6v6a2 2 0 1 0 0 4v5h-6a2 2 0 1 0-4 0H4v-6a2 2 0 1 1 0-4V5Z"/></>;
    case "shooter": return <><path d="M4 13h10l3-4h3v8h-6l-2 3H8l1-3H4v-4Z"/><path d="M7 13V9h5"/></>;
    case "survival": return <><path d="M12 3c4 4 6 7 6 11a6 6 0 1 1-12 0c0-2 1-4 3-6 0 3 1 4 3 5 2-2 1-6 0-10Z"/></>;
    case "open-steam": case "steam": return <><circle cx="12" cy="12" r="8.5"/><circle cx="15.5" cy="8.5" r="2.3"/><circle cx="8.3" cy="15.5" r="2"/><path d="m10 14.2 3.8-4M4.7 14l2 1"/></>;
    case "play-now": return <><circle cx="12" cy="12" r="8.5"/><path d="m10 8 6 4-6 4V8Z"/></>;
    case "draw-again": case "retry": return <><path d="M19 8V4l-2 2a8 8 0 1 0 2.3 8"/><path d="M19 4h-4"/></>;
    case "refresh-prices": return <><path d="M19 8V4l-2 2a8 8 0 1 0 2.3 8"/><path d="M19 4h-4M9 9h6m-6 6h6m-4-8v10"/></>;
    case "sync": case "refresh-data": return <><path d="M4 9a8 8 0 0 1 13-3l2 2M20 15a8 8 0 0 1-13 3l-2-2"/><path d="M19 4v4h-4M5 20v-4h4"/></>;
    case "draw-from-vault": return <><path d="M4 7h3c4 0 6 10 10 10h3M17 4l3 3-3 3M4 17h3c1.7 0 3-1.5 4.2-3.4M17 14l3 3-3 3"/><circle cx="12" cy="12" r="2"/></>;
    case "shuffle": return <><path d="M4 7h3c4 0 6 10 10 10h3M17 4l3 3-3 3M4 17h3c1.7 0 3-1.5 4.2-3.4M17 14l3 3-3 3"/></>;
    case "open-vault": return <><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3"/><path d="M12 8.5v-2m3 4 2-1m-2 4 2 1m-5 1v2m-3-4-2 1m2-4-2-1"/></>;
    case "snooze": case "sleep": return <><path d="M6 17h8M8 14h8M10 11h8"/><path d="M17.5 5.5A7 7 0 1 0 18 17a7.5 7.5 0 0 1-.5-11.5Z"/></>;
    case "snooze-not-now": return <><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2M6 19l12-14"/></>;
    case "details": case "view-details": return <><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.8"/></>;
    case "add-game": return <><path d="M4 11h16l-1 7a2 2 0 0 1-2 1.7H7A2 2 0 0 1 5 18l-1-7Z"/><path d="M12 4v6M9 7h6"/></>;
    case "new-collection": return <><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 3v4m8-4v4M12 10v6m-3-3h6"/></>;
    case "restore-active": return <><circle cx="12" cy="12" r="8.5"/><path d="m9 9-3 3 3 3M6 12h7a4 4 0 0 1 4 4"/></>;
    case "undo": return <><path d="m9 7-4 4 4 4"/><path d="M5 11h8a6 6 0 0 1 6 6v1"/></>;
    case "save-follow": case "bookmark": return P("M7 4h10v17l-5-3-5 3V4Z");
    case "remove": case "delete": return <><path d="M5 7h14M9 7V4h6v3m2 0-1 13H8L7 7M10 11v5m4-5v5"/></>;
    case "collection-picker": case "selected-collection": return <><rect x="4" y="5" width="16" height="14" rx="2"/><path d="m8 12 2.5 2.5L16 9"/></>;
    case "lock": return <><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>;
    case "shield": case "privacy": return <><path d="M12 3 5 6v5c0 4.3 2.8 8.2 7 10 4.2-1.8 7-5.7 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-5"/></>;
    case "guest": case "user": return <><circle cx="12" cy="8" r="3"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/></>;
    case "players": return <><circle cx="10" cy="8" r="3"/><path d="M4 20v-2a6 6 0 0 1 12 0v2M17 6a3 3 0 0 1 0 6m3 8v-2a5 5 0 0 0-3-4.6"/></>;
    case "id": return <><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="8" cy="11" r="2"/><path d="M13 10h5M13 14h4"/></>;
    case "browser": return <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/></>;
    case "terms": return <><path d="M6 3h9l4 4v14H6V3Z"/><path d="M15 3v5h5M9 12h7m-7 4h7"/></>;
    case "steam-data": return <><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></>;
    case "contact": return <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></>;
    case "feedback": return <><path d="M4 5h16v12H9l-5 4V5Z"/><path d="M8 9h8m-8 4h5"/></>;
    case "cookies": return <><path d="M19 13a7 7 0 1 1-8-8 4 4 0 0 0 4 4 4 4 0 0 0 4 4Z"/><circle cx="9" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="16" r="1" fill="currentColor" stroke="none"/></>;
    case "keep-active": return <><circle cx="12" cy="12" r="8.5"/><path d="m8 12 2.5 2.5L16.5 8"/></>;
    case "untouched": return <><path d="M5 19 19 5M7 5h12v12"/><circle cx="7" cy="17" r="2"/></>;
    case "barely-started": return <><path d="M4 18h16M6 15h5l3-8h4"/><circle cx="16" cy="7" r="2"/></>;
    case "dormant": return <><path d="M4 16c3-5 13-5 16 0-4 4-12 4-16 0Z"/><path d="M9 10c1-3 5-5 8-5-1 4-4 7-8 7"/></>;
    case "ready-to-review": return <><path d="M5 4h14v16H5V4Z"/><path d="M8 8h8m-8 4h5"/><circle cx="16" cy="16" r="4"/><path d="m19 19 2 2"/></>;
    case "actioned": return <><circle cx="12" cy="12" r="8.5"/><path d="m8 12 2.5 2.5L16.5 8"/><path d="M12 3.5v2m0 13v2"/></>;
    case "no-review-needed": return <><path d="M5 6h14v13H5V6Z"/><path d="M8 3v5m8-5v5M8 12h8"/><path d="m10 16 1.5 1.5L15 14"/></>;
    default: return <><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></>;
  }
}

export function SiteGlyph({ name, size = 24, className, title, style }: SiteGlyphProps) {
  return <svg
    className={className}
    style={style}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.85"
    strokeLinecap="round"
    strokeLinejoin="round"
    role={title ? "img" : undefined}
    aria-hidden={title ? undefined : true}
  >
    {title ? <title>{title}</title> : null}
    <circle cx="12" cy="12" r="10.25" opacity=".08" fill="currentColor" stroke="none" />
    {glyph(name)}
  </svg>;
}
