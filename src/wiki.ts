const WIKI_HOST = "fr.wikipedia.org";

/** Extrait le titre d'article depuis un lien wiki (relatif ou absolu). */
export function titleFromWikiHref(href: string): string | null {
  try {
    if (href.startsWith("/wiki/")) {
      return decodeURIComponent(href.slice(6)).replace(/_/g, " ");
    }
    const u = new URL(href, `https://${WIKI_HOST}`);
    if (u.hostname !== WIKI_HOST) return null;
    const m = u.pathname.match(/^\/wiki\/(.+)$/);
    if (!m) return null;
    return decodeURIComponent(m[1]).replace(/_/g, " ");
  } catch {
    return null;
  }
}
