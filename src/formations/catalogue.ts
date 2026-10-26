import catalogue from './catalogue.json'

/**
 * Catalogue de formations IFECARM GROUP (395 fiches, 10 familles) : copie
 * du catalogue du site vitrine (ifecarm/app/data/formations.ts), sans les
 * contenus détaillés — juste de quoi choisir une formation (slug, intitulé,
 * durée). À régénérer quand le catalogue du site évolue.
 */
export interface FicheFormation { slug: string, titre: string, duree: string, famille: string }

export const FAMILLES: { id: string, label: string }[] = catalogue.map((f) => ({ id: f.id, label: f.label }))

export const FICHES: FicheFormation[] = catalogue.flatMap((f) =>
  f.formations.map((x) => ({ slug: x.slug, titre: x.titre, duree: x.duree, famille: f.label })))

const PAR_SLUG = new Map(FICHES.map((f) => [f.slug, f]))
export const ficheDe = (slug: string): FicheFormation | undefined => PAR_SLUG.get(slug)
