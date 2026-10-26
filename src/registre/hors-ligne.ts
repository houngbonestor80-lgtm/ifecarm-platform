'use client'

/**
 * B3 hors ligne : une déclaration saisie sur le terrain est TOUJOURS d'abord écrite dans IndexedDB (boîte
 * d'envoi), puis envoyée dès que possible. Rien n'est perdu si le réseau tombe, si l'onglet est fermé ou si le
 * serveur est injoignable. L'identifiant `cleClient` (aléatoire, généré ici) rend l'envoi rejouable sans
 * doublon : le serveur renvoie la même déclaration si la clé est déjà connue (0035).
 *
 * Contenu d'une entrée : les faits, les photos DÉJÀ réduites (EXIF supprimé) sous forme de Blob, et le
 * compte qui l'a saisie. Une entrée n'est envoyée que par ce même compte : sur un appareil partagé, une
 * déclaration d'un collègue n'est jamais postée sous une autre identité (et inversement).
 * Les photos ne sont jamais envoyées par une requête qui redirige vers la connexion : un 401 suspend l'envoi.
 */

const BASE = 'ifecarm-registre'
const SORTIE = 'sortie'
const CACHE = 'cache'

export interface EntreeSortie {
  cleClient: string
  utilisateurId: string
  entrepriseId: string
  corps: Record<string, unknown>
  photos: { nom: string, blob: Blob }[]
  creeLe: number
  /** Déclaration déjà créée côté serveur (reste à envoyer les photos). */
  envoyee?: { id: string, reference: string }
  /** Refus définitif du serveur (validation, droits, module) : affiché à l'utilisateur, jamais réessayé seul. */
  refus?: string
}

export interface ContexteHorsLigne {
  moi: string
  entrepriseId: string
  sites: { id: string, nom: string }[]
  salaries: { id: string, nom: string, prenom: string }[]
  equipe: boolean
  responsable: boolean
}

function ouvrir(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(BASE, 1)
    r.onupgradeneeded = () => {
      r.result.createObjectStore(SORTIE, { keyPath: 'cleClient' })
      r.result.createObjectStore(CACHE)
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

async function tx<T>(magasin: string, mode: IDBTransactionMode, cb: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await ouvrir()
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(magasin, mode)
      const req = cb(t.objectStore(magasin))
      t.oncomplete = () => resolve(req.result)
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
  } finally {
    db.close()
  }
}

/** Demande au navigateur de ne pas purger la boîte d'envoi quand le stockage est sous pression. */
export async function demanderStockagePersistant(): Promise<void> {
  try { await navigator.storage?.persist?.() } catch { /* sans effet : on continue */ }
}

export const enregistrerEnSortie = (e: EntreeSortie) => tx(SORTIE, 'readwrite', (s) => s.put(e)).then(() => undefined)
export const supprimerDeSortie = (cleClient: string) => tx(SORTIE, 'readwrite', (s) => s.delete(cleClient)).then(() => undefined)
export const listerSortie = () => tx<EntreeSortie[]>(SORTIE, 'readonly', (s) => s.getAll()).then((l) => l.sort((a, b) => a.creeLe - b.creeLe))

/**
 * Durée de vie du contexte gardé sur l'appareil (sites, salariés, nom d'entreprise, modules) : celle d'une session (12 h,
 * src/auth/session.ts). Au-delà, il n'est plus relu et il est effacé : une session expirée sans déconnexion ne laisse pas
 * ces données indéfiniment sur l'appareil. La boîte d'envoi (déclarations non envoyées) n'est PAS concernée.
 */
export const DUREE_CONTEXTE_MS = 12 * 3_600_000

export const memoriserContexte = (c: ContexteHorsLigne) => tx(CACHE, 'readwrite', (s) => s.put({ ...c, memoriseLe: Date.now() }, 'contexte')).then(() => undefined)
export async function contexteMemorise(): Promise<ContexteHorsLigne | undefined> {
  const c = await tx<(ContexteHorsLigne & { memoriseLe?: number }) | undefined>(CACHE, 'readonly', (s) => s.get('contexte'))
  if (!c) return undefined
  if (typeof c.memoriseLe !== 'number' || Date.now() - c.memoriseLe > DUREE_CONTEXTE_MS) {
    await viderCache().catch(() => undefined)
    return undefined
  }
  const { memoriseLe: _, ...contexte } = c
  return contexte
}
export const viderCache = () => tx(CACHE, 'readwrite', (s) => s.clear()).then(() => undefined)

export interface BilanEnvoi {
  envoyees: { reference: string }[]
  restantes: number
  refusees: number
  /** Envoi suspendu : hors ligne, serveur injoignable ou session expirée (l'utilisateur doit se reconnecter). */
  suspendu: 'reseau' | 'session' | null
}

let enCours: Promise<BilanEnvoi> | null = null

/** Envoie la boîte d'envoi du compte courant, dans l'ordre. Un seul envoi à la fois, même entre onglets (Web Locks). */
export function synchroniser(moi: string): Promise<BilanEnvoi> {
  if (enCours) return enCours
  const lancer = async (): Promise<BilanEnvoi> => envoyerTout(moi)
  const p = (async (): Promise<BilanEnvoi> =>
    navigator.locks ? await navigator.locks.request<Promise<BilanEnvoi>>('ifecarm-registre-envoi', lancer) : await lancer())()
  const suivi = p.finally(() => { enCours = null })
  enCours = suivi
  return suivi
}

async function envoyerTout(moi: string): Promise<BilanEnvoi> {
  const bilan: BilanEnvoi = { envoyees: [], restantes: 0, refusees: 0, suspendu: null }
  for (const e of await listerSortie()) {
    if (e.utilisateurId !== moi || e.refus) continue
    try {
      if (!e.envoyee) {
        const r = await fetch('/api/registre/declarations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...e.corps, cleClient: e.cleClient, saisiHorsLigne: true }) })
        if (r.status === 401) { bilan.suspendu = 'session'; break }
        const donnees = await r.json().catch(() => ({}))
        if (r.status >= 500) { bilan.suspendu = 'reseau'; break }
        if (!r.ok) { await enregistrerEnSortie({ ...e, refus: donnees.erreur ?? `Refusée (${r.status}).` }); continue }
        e.envoyee = { id: donnees.id, reference: donnees.reference }
        await enregistrerEnSortie(e)
      }
      while (e.photos.length) {
        const photo = e.photos[0]!
        const form = new FormData()
        form.append('photo', photo.blob, photo.nom)
        const r = await fetch(`/api/registre/declarations/${e.envoyee.id}/pieces`, { method: 'POST', body: form })
        if (r.status === 401) { bilan.suspendu = 'session'; break }
        if (r.status >= 500) { bilan.suspendu = 'reseau'; break }
        // Photo refusée (déjà qualifiée, format, plafond) : la déclaration, elle, est bien partie — on abandonne cette photo.
        e.photos.shift()
        await enregistrerEnSortie(e)
      }
      if (bilan.suspendu) break
      await supprimerDeSortie(e.cleClient)
      bilan.envoyees.push({ reference: e.envoyee.reference })
    } catch {
      bilan.suspendu = 'reseau' // fetch rejeté : pas de réseau
      break
    }
  }
  const reste = (await listerSortie()).filter((e) => e.utilisateurId === moi)
  bilan.restantes = reste.filter((e) => !e.refus).length
  bilan.refusees = reste.filter((e) => e.refus).length
  return bilan
}

export const nouvelleCle = () => crypto.randomUUID()
