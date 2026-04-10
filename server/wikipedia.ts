import * as cheerio from "cheerio";

const WIKI_BASE = "https://fr.wikipedia.org";

const UA = {
  "User-Agent": "WikiraceEducational/1.0 (contact: local-dev)",
};

function cleanTitleInput(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/_/g, " ");
}

/** Vérifie si un titre existe et renvoie le titre canonique (redirections incluses). */
async function queryCanonicalTitle(title: string): Promise<string | null> {
  const params = new URLSearchParams({
    action: "query",
    titles: title,
    redirects: "1",
    format: "json",
    formatversion: "2",
    origin: "*",
  });
  const url = `${WIKI_BASE}/w/api.php?${params}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    query?: { pages?: Array<{ title?: string; missing?: boolean }> };
  };
  const pages = data.query?.pages;
  if (!pages?.length) return null;
  const p = pages[0];
  if (p.missing) return null;
  return p.title ?? null;
}

/** Première suggestion OpenSearch (articles principaux). */
async function opensearchFirst(search: string): Promise<string | null> {
  const params = new URLSearchParams({
    action: "opensearch",
    search,
    limit: "10",
    namespace: "0",
    format: "json",
    origin: "*",
  });
  const url = `${WIKI_BASE}/w/api.php?${params}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return null;
  const data = (await res.json()) as [string, string[]];
  const titles = data[1];
  if (!titles?.length) return null;
  return titles[0] ?? null;
}

/**
 * Résout une saisie utilisateur vers un titre d'article existant
 * (espaces, casse, redirections, fautes approximatives via OpenSearch).
 */
export async function resolvePageTitle(raw: string): Promise<string> {
  const clean = cleanTitleInput(raw);
  if (!clean) throw new Error("Titre vide");

  let found = await queryCanonicalTitle(clean);
  if (found) return found;

  const cap = clean.charAt(0).toUpperCase() + clean.slice(1);
  if (cap !== clean) {
    found = await queryCanonicalTitle(cap);
    if (found) return found;
  }

  let guess = await opensearchFirst(clean);
  if (guess) return guess;

  if (cap !== clean) {
    guess = await opensearchFirst(cap);
    if (guess) return guess;
  }

  const firstWord = clean.split(/\s+/)[0];
  if (firstWord && firstWord.length >= 3 && firstWord !== clean) {
    guess = await opensearchFirst(firstWord);
    if (guess) return guess;
  }

  throw new Error(`Aucun article trouvé pour « ${clean} »`);
}

export type ParsedPage = {
  title: string;
  html: string;
  /** Titres canoniques des pages atteignables depuis cette page (liens wiki internes). */
  linkTitles: string[];
};

function normalizeWikiTitleFromHref(href: string): string | null {
  try {
    const u = new URL(href, WIKI_BASE);
    if (u.hostname !== "fr.wikipedia.org") return null;
    const m = u.pathname.match(/^\/wiki\/(.+)$/);
    if (!m) return null;
    const raw = decodeURIComponent(m[1]);
    if (
      raw.startsWith("Fichier:") ||
      raw.startsWith("File:") ||
      raw.startsWith("Catégorie:") ||
      raw.startsWith("Category:") ||
      raw.startsWith("Spécial:") ||
      raw.startsWith("Special:") ||
      raw.startsWith("Wikipédia:") ||
      raw.startsWith("Wikipedia:") ||
      raw.startsWith("Modèle:") ||
      raw.startsWith("Template:") ||
      raw.startsWith("Aide:") ||
      raw.startsWith("Help:")
    ) {
      return null;
    }
    return raw.replace(/_/g, " ");
  } catch {
    return null;
  }
}

function extractLinksFromHtml(html: string): Set<string> {
  const $ = cheerio.load(html);
  const titles = new Set<string>();
  $('a[href^="/wiki/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const t = normalizeWikiTitleFromHref(`${WIKI_BASE}${href}`);
    if (t) titles.add(t);
  });
  return titles;
}

/** Liens wiki depuis un fragment déjà parsé (évite un second parse). */
function extractWikiLinksFromRoot(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<cheerio.Element>
): string[] {
  const titles = new Set<string>();
  root.find('a[href^="/wiki/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const t = normalizeWikiTitleFromHref(`${WIKI_BASE}${href}`);
    if (t) titles.add(t);
  });
  return [...titles];
}

/** Allège le DOM affiché (références, bandeaux, médias lourds) — les liens sont déjà extraits. */
function lightenArticleDom(
  $: cheerio.CheerioAPI,
  out: cheerio.Cheerio<cheerio.Element>
): void {
  out
    .find(
      [
        ".references",
        ".reflist",
        ".mw-references-wrap",
        ".reference",
        "sup.reference",
        ".navbox",
        ".vertical-navbox",
        ".metadata",
        ".noprint",
        ".mw-empty-elt",
        ".bandeau-container",
        ".bandeau-simple",
        ".ambox",
        ".tmbox",
        ".sistersitebox",
        ".sisterproject",
        ".listen",
        ".catlinks",
        ".printfooter",
        "audio",
        "video",
        "iframe",
        "object",
      ].join(", ")
    )
    .remove();

  out.find("img").each((_, el) => {
    $(el).attr("loading", "lazy");
    $(el).attr("decoding", "async");
  });

  out.find("svg").remove();
}

/** Titre d'un article aléatoire (namespace principal), en évitant d'éventuels titres exclus. */
export async function fetchRandomMainArticleTitle(
  excludeTitles: string[] = []
): Promise<string> {
  const normTitle = (s: string) =>
    s.trim().toLowerCase().replace(/_/g, " ");
  const excludeNorm = new Set(excludeTitles.map(normTitle).filter(Boolean));

  for (let attempt = 0; attempt < 10; attempt++) {
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      origin: "*",
      generator: "random",
      grnnamespace: "0",
      grnlimit: "1",
    });
    const url = `${WIKI_BASE}/w/api.php?${params}`;
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error("API Wikipedia indisponible");
    const data = (await res.json()) as {
      query?: { pages?: Array<{ title?: string; missing?: boolean }> };
    };
    const pages = data.query?.pages;
    const p = pages?.[0];
    if (!p?.title || p.missing) continue;
    if (!excludeNorm.has(normTitle(p.title))) return p.title;
  }
  throw new Error("Impossible de tirer un article aléatoire");
}

/** Parse sans résolution (titre déjà canonique, ex. page courante en jeu). */
export async function fetchParsedPageCanonical(
  canonicalTitle: string
): Promise<ParsedPage> {
  const params = new URLSearchParams({
    action: "parse",
    page: canonicalTitle,
    prop: "text",
    format: "json",
    formatversion: "2",
    redirects: "1",
    origin: "*",
  });
  const url = `${WIKI_BASE}/w/api.php?${params}`;
  const res = await fetch(url, {
    headers: UA,
  });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const data = (await res.json()) as {
    error?: { info?: string };
    parse?: { title: string; text: string };
  };
  if (data.error) {
    throw new Error(data.error.info ?? "Page introuvable");
  }
  if (!data.parse?.text) {
    throw new Error("Réponse Wikipedia invalide");
  }
  const title = data.parse.title;
  const $ = cheerio.load(data.parse.text);
  const out = $(".mw-parser-output");
  if (!out.length) {
    throw new Error("Contenu article introuvable");
  }
  out.find(".navbox, .metadata, .noprint, .mw-empty-elt").remove();
  const linkTitles = extractWikiLinksFromRoot($, out);
  lightenArticleDom($, out);
  const fragment = out.html() ?? "";
  return { title, html: fragment, linkTitles };
}

export async function fetchParsedPage(pageTitle: string): Promise<ParsedPage> {
  const resolved = await resolvePageTitle(pageTitle);
  return fetchParsedPageCanonical(resolved);
}

/** Libellés d’infobox / champs jugés utiles comme indices (fr.wikipedia). */
const CLUE_LABEL_RE =
  /nationalit|naissance|décès|né\s|née\s|mort|pays|genre|activité|profession|formation|domaine|œuvre|distinction|langue|religion|parti\b|date|siège|population|superficie|création|fondation|chef-lieu|monar|régent|président|premier ministre|découv|publi|sortie|sorti|genre musical|style|période|époque|siècle|nombre hab|recensement|altitude|longueur|largeur|volume|masse|vitesse|capitale|réside|né le|née le/i;

function extractCluesFromParsedHtml(parseHtml: string): string[] {
  const $ = cheerio.load(parseHtml);
  const root = $(".mw-parser-output");
  if (!root.length) return [];

  const clues: string[] = [];
  const seen = new Set<string>();

  root
    .find('table.infobox, table.infobox_v2, table.infobox_v3, table[class*="infobox"]')
    .first()
    .find("tr")
    .each((_, tr) => {
      const $tr = $(tr);
      const th = $tr.find("th").first();
      const td = $tr.find("td").first();
      if (!th.length || !td.length) return;
      const label = th
        .text()
        .replace(/\s+/g, " ")
        .replace(/\[\d+\]/g, "")
        .trim();
      let value = td
        .text()
        .replace(/\s+/g, " ")
        .replace(/\[\d+\]/g, "")
        .trim();
      if (!label || !value) return;
      if (label.length > 42) return;
      if (!CLUE_LABEL_RE.test(label)) return;
      if (value.length > 240) value = `${value.slice(0, 237)}…`;
      const clue = `${label} — ${value}`;
      const k = clue.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      clues.push(clue);
    });

  const introChunks: string[] = [];
  root.children("p").each((_, el) => {
    if (introChunks.length >= 3) return;
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t.length > 50) introChunks.push(t);
  });
  const intro = introChunks.join(" ");

  const yearRe = /\b(1[0-9]{3}|20[0-2][0-9])\b/g;
  let ym: RegExpExecArray | null;
  const years = new Set<string>();
  while ((ym = yearRe.exec(intro)) !== null) years.add(ym[1]);
  for (const y of [...years].slice(0, 5)) {
    const c = `Année mentionnée dans l’introduction : ${y}`;
    const k = c.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      clues.push(c);
    }
  }

  const dateFr =
    /\b(\d{1,2}\s+(?:janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+\d{4})\b/gi;
  let dm: RegExpExecArray | null;
  while ((dm = dateFr.exec(intro)) !== null && clues.length < 18) {
    const c = `Date mentionnée dans l’introduction : ${dm[1]}`;
    const k = c.toLowerCase();
    if (!seen.has(k) && dm[1].length < 60) {
      seen.add(k);
      clues.push(c);
    }
  }

  for (let i = clues.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [clues[i], clues[j]] = [clues[j], clues[i]];
  }

  return clues.slice(0, 14);
}

/** Indices sur la page cible (infobox + dates dans l’intro), pour dévoilement progressif côté client. */
export async function fetchTargetPageClues(
  rawTitle: string
): Promise<{ title: string; clues: string[] }> {
  const resolved = await resolvePageTitle(rawTitle);
  const params = new URLSearchParams({
    action: "parse",
    page: resolved,
    prop: "text",
    format: "json",
    formatversion: "2",
    redirects: "1",
    origin: "*",
  });
  const url = `${WIKI_BASE}/w/api.php?${params}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const data = (await res.json()) as {
    error?: { info?: string };
    parse?: { title: string; text: string };
  };
  if (data.error) {
    throw new Error(data.error.info ?? "Page introuvable");
  }
  if (!data.parse?.text) {
    throw new Error("Réponse Wikipedia invalide");
  }
  const clues = extractCluesFromParsedHtml(data.parse.text);
  return { title: data.parse.title, clues };
}

export function isValidNextPage(
  currentPageTitle: string,
  targetTitle: string,
  allowedLinks: string[]
): boolean {
  const norm = (s: string) =>
    s.replace(/_/g, " ").trim().toLowerCase();
  const t = norm(targetTitle);
  return allowedLinks.some((l) => norm(l) === t);
}

/** Tente une navigation depuis la page courante (validation des liens Wikipedia). */
export async function tryNavigate(
  fromTitle: string,
  toTitle: string
): Promise<ParsedPage> {
  const currentPage = await fetchParsedPageCanonical(fromTitle);
  if (!isValidNextPage(fromTitle, toTitle, currentPage.linkTitles)) {
    throw new Error("Lien invalide depuis cette page");
  }
  return fetchParsedPage(toTitle);
}
