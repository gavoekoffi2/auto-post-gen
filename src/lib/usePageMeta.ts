import { useEffect } from "react";

/**
 * Sets the document title and meta description for a route.
 *
 * This is a single-page app: without it, every route keeps the title baked
 * into index.html. Every page — the FAQ, the terms, the sign-in screen —
 * announced itself as "Pro Social AI - Publication Automatisée sur Réseaux
 * Sociaux". That is the text a browser tab shows, what a bookmark and the
 * history entry are named, what a screen reader reads on navigation, and what
 * a search engine indexes for the page.
 *
 * Deliberately tiny: no dependency, and it restores nothing on unmount because
 * the next route sets its own.
 */
export function usePageMeta(title: string, description?: string): void {
  useEffect(() => {
    document.title = `${title} · Pro Social AI`;
    if (!description) return;
    let tag = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!tag) {
      tag = document.createElement("meta");
      tag.name = "description";
      document.head.appendChild(tag);
    }
    tag.content = description;
  }, [title, description]);
}
