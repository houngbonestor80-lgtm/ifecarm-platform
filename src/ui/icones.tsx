/** Icônes inline (traits 2px, style proche de Font Awesome utilisé sur le site) — aucune dépendance. */
type P = { className?: string }
const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }

export const IconeCoche = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
)
export const IconeCroix = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="M6 6l12 12M18 6L6 18" /></svg>
)
export const IconeMoins = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="M6 12h12" /></svg>
)
export const IconePlus = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="M12 5v14M5 12h14" /></svg>
)
export const IconeAlerte = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="M12 3l9.5 17h-19L12 3z" /><path d="M12 10v4M12 17.5v.01" /></svg>
)
export const IconeHorloge = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
)
export const IconeCalendrier = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
)
export const IconeBatiment = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="M4 21V5l8-2v18M12 8l8 2v11M3 21h18M7.5 8v.01M7.5 12v.01M7.5 16v.01M16 13v.01M16 17v.01" /></svg>
)
export const IconeOutil = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="M14.5 6.5a4 4 0 00-5.2 5.2L4 17l3 3 5.3-5.3a4 4 0 005.2-5.2l-2.5 2.5-2.5-.5-.5-2.5 2.5-2.5z" /></svg>
)
export const IconePersonne = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" /></svg>
)
export const IconeListe = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></svg>
)
export const IconeEchange = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="M7 7h13l-3-3M17 17H4l3 3" /></svg>
)
export const IconeSortie = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11" /></svg>
)
export const IconeBouclier = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></svg>
)
export const IconeCommentaire = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="M4 5h16v11H9l-5 4V5z" /></svg>
)
export const IconeAppareilPhoto = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><path d="M4 8h3l2-3h6l2 3h3v11H4V8z" /><circle cx="12" cy="13" r="3.5" /></svg>
)
export const IconeGalerie = ({ className }: P) => (
  <svg viewBox="0 0 24 24" className={className} {...base}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="M21 16l-5-5-8 9" /></svg>
)
