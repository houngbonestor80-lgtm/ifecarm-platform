'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { IconeCoche, IconeListe, IconePlus, IconeSortie } from '@/ui/icones'

type Module = 'inspections' | 'tableau_bord' | 'formations' | 'incidents' | 'habilitations' | 'autodiagnostic'
interface Entreprise {
  id: string
  nom: string
  statut_relation: 'client' | 'prospect'
  pays: string
  modules: { module: Module, actif: boolean }[]
  acces: { utilisateur_id: string, nom: string, ecriture: boolean, fin_le: string | null }[]
}
interface Consultant { id: string, nom: string, email: string, cree_le: string, acces: { entreprise_id: string, nom: string, ecriture: boolean, fin_le: string | null }[] }
interface Donnees { entreprises: Entreprise[], consultants: Consultant[], modules: Module[] }
interface Pays { code: string, nom: string, actif: boolean }

const LIBELLE_MODULE: Record<Module, string> = {
  inspections: 'Inspections', tableau_bord: 'Tableau de bord', formations: 'Formations', incidents: 'Incidents', habilitations: 'Habilitations', autodiagnostic: 'Autodiagnostic',
}
const MODULES_PROSPECT: Module[] = ['inspections', 'tableau_bord', 'autodiagnostic']

/**
 * Administration (administrateur) : créer un client, choisir ses modules et
 * les consultants qui peuvent y entrer. Les droits sont contrôlés en base ;
 * cette page ne fait que refléter ce qui est permis.
 */
export default function PageAdministration() {
  const [d, setD] = useState<Donnees | null>(null)
  const [pays, setPays] = useState<Pays[]>([])
  const [erreur, setErreur] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)
  const [nouveau, setNouveau] = useState<{ nom: string, pays: string, secteur: string, modules: Module[] }>({ nom: '', pays: 'BJ', secteur: '', modules: ['inspections', 'tableau_bord'] })
  const [ajout, setAjout] = useState<Record<string, { consultantId: string, ecriture: boolean }>>({})
  const [consultant, setConsultant] = useState({ nom: '', email: '' })
  const [recherche, setRecherche] = useState('')
  const [reinit, setReinit] = useState<{ nom: string, email: string, motDePasse: string } | null>(null)
  const [provisoire, setProvisoire] = useState<{ nom: string, email: string, motDePasse: string } | null>(null)

  const charger = useCallback(() => {
    api<Donnees>('/api/administration').then(setD).catch((e) => {
      if ((e as { statut?: number }).statut === 403) return window.location.assign('/vue-ensemble')
      setErreur(messageErreur(e))
    })
  }, [])
  useEffect(() => {
    charger()
    api<{ pays: Pays[] }>('/api/pays').then((r) => {
      const actifs = r.pays.filter((p) => p.actif)
      setPays(actifs)
      setNouveau((n) => (actifs.some((p) => p.code === n.pays) ? n : { ...n, pays: actifs[0]?.code ?? n.pays }))
    }).catch(() => {})
  }, [charger])

  async function agir(fn: () => Promise<unknown>, ok?: string) {
    setErreur(null)
    setMessage(null)
    setEnCours(true)
    try {
      await fn()
      if (ok) setMessage(ok)
      charger()
      return true
    } catch (e) {
      setErreur(messageErreur(e))
      return false
    } finally {
      setEnCours(false)
    }
  }

  async function creer(ev: React.FormEvent) {
    ev.preventDefault()
    if (await agir(() => api('/api/administration/clients', { method: 'POST', corps: nouveau }), `Client « ${nouveau.nom} » créé.`)) {
      setNouveau({ ...nouveau, nom: '', secteur: '' })
    }
  }

  const consultantsFiltres = (d?.consultants ?? []).filter((c) => {
    const mots = recherche.toLowerCase().split(/s+/).filter(Boolean)
    return mots.every((m) => c.nom.toLowerCase().includes(m) || c.email.toLowerCase().includes(m))
  })
  const consultantsVisibles = consultantsFiltres.slice(0, 50)

  async function reinitialiserMotDePasse(c: Consultant) {
    if (!window.confirm(`Générer un nouveau mot de passe pour ${c.nom} ? L’ancien ne fonctionnera plus et il sera déconnecté.`)) return
    setReinit(null)
    await agir(async () => {
      const r = await api<{ motDePasse: string }>(`/api/administration/consultants/${c.id}`, { method: 'PATCH', corps: { action: 'mot_de_passe' } })
      setReinit({ nom: c.nom, email: c.email, ...r })
    })
  }

  async function reinitialiser2fa(c: Consultant) {
    if (!window.confirm(`Réinitialiser la double authentification de ${c.nom} ? Ses codes de secours et ses appareils de confiance seront supprimés, il sera déconnecté et devra la réactiver à sa prochaine connexion.`)) return
    await agir(() => api(`/api/administration/comptes/${c.id}/2fa`, { method: 'POST', corps: {} }), `Double authentification de ${c.nom} réinitialisée.`)
  }

  async function supprimerConsultant(c: Consultant) {
    const saisie = window.prompt(
      `Suppression DÉFINITIVE du compte de ${c.nom}.

Ses accès sont retirés et il est déconnecté aussitôt. Ses inspections, notes et sessions restent, sans lien vers ce compte.

Pour confirmer, tapez son email (${c.email}) :`,
    )
    if (saisie === null) return
    await agir(() => api(`/api/administration/consultants/${c.id}`, { method: 'DELETE', corps: { confirmation: saisie } }), `Compte de ${c.nom} supprimé.`)
  }

  async function creerConsultant(ev: React.FormEvent) {
    ev.preventDefault()
    setProvisoire(null)
    if (await agir(async () => {
      const r = await api<{ motDePasse: string }>('/api/administration/consultants', { method: 'POST', corps: consultant })
      setProvisoire({ nom: consultant.nom, email: consultant.email, ...r })
    })) setConsultant({ nom: '', email: '' })
  }

  const modifier = (e: Entreprise, corps: Record<string, unknown>) =>
    agir(() => api(`/api/administration/entreprises/${e.id}`, { method: 'PATCH', corps }))

  async function deconnecter() {
    await fetch('/api/auth/deconnexion', { method: 'POST' })
    window.location.assign('/connexion')
  }

  return (
    <>
      <header className="entete">
        <div className="entete__barre">
          <a className="marque" href="/vue-ensemble" aria-label="IFECARM GROUP — Plateforme QHSE, vue d’ensemble">
            <img src="/brand/logo-circle.svg" alt="" />
            <span className="marque__texte"><span className="marque__nom">IFECARM GROUP</span><span className="marque__sous">Plateforme QHSE</span></span>
          </a>
          <nav className="entete__actions" aria-label="Session" style={{ marginLeft: 'auto' }}>
            <a className="lien-entete" href="/vue-ensemble" title="Vue d’ensemble de tous les clients"><IconeListe /><span className="libelle">Vue d’ensemble</span></a>
            <button type="button" className="lien-entete" onClick={deconnecter}><IconeSortie /><span className="libelle">Déconnexion</span></button>
          </nav>
        </div>
      </header>

      <main className="contenu contenu--etroit">
        <div className="tete-page">
          <div>
            <div className="tete-page__sur">Administration</div>
            <h1>Clients, modules et accès</h1>
            <p className="tete-page__desc">Créez un client, choisissez les modules qu’il utilise et les consultants qui peuvent intervenir chez lui.</p>
            <p style={{ marginTop: 8 }}><a href="/administration/catalogue">Catalogue de formations : validité des certifications →</a></p>
            <p style={{ marginTop: 8 }}><a href="/administration/habilitations">Catalogue d’habilitations : types et durées de validité →</a></p>
            <p style={{ marginTop: 8 }}><a href="/administration/autodiagnostic">Référentiels d’autodiagnostic : questionnaires, niveaux, recommandations →</a></p>
          </div>
        </div>

        {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}
        {message && <div className="alerte alerte--info" role="status" style={{ marginBottom: 14 }}><IconeCoche /> {message}</div>}

        <form className="carte" onSubmit={creerConsultant} style={{ marginBottom: 24 }}>
          <div className="carte__titre"><h2>Nouveau consultant</h2></div>
          <div className="grille-2">
            <div className="champ">
              <label htmlFor="c-nom">Nom</label>
              <input id="c-nom" className="saisie" required maxLength={200} value={consultant.nom} onChange={(e) => setConsultant({ ...consultant, nom: e.target.value })} />
            </div>
            <div className="champ">
              <label htmlFor="c-email">Email</label>
              <input id="c-email" className="saisie" type="email" required maxLength={254} value={consultant.email} onChange={(e) => setConsultant({ ...consultant, email: e.target.value })} />
            </div>
          </div>
          <span className="aide">Le compte n’a accès à aucune entreprise tant que vous ne lui en accordez pas, ci-dessous.</span>
          {provisoire && (
            <div className="alerte alerte--info" role="status" style={{ marginTop: 12 }}>
              <strong>Compte créé pour {provisoire.nom} ({provisoire.email}).</strong> Mot de passe provisoire, affiché une seule fois :{' '}
              <code style={{ fontSize: '1.05rem', userSelect: 'all' }}>{provisoire.motDePasse}</code>
            </div>
          )}
          <button type="submit" className="bouton" disabled={enCours || !consultant.nom.trim() || !consultant.email.trim()} style={{ marginTop: 14 }}><IconePlus /> Créer le consultant</button>
        </form>

        <section className="carte" style={{ marginBottom: 24 }}>
          <div className="carte__titre"><h2>Consultants ({d?.consultants.length ?? 0})</h2></div>
          <p className="texte-discret" style={{ marginTop: 0 }}>
            L’accès d’un consultant à une entreprise se donne ou se retire depuis la fiche de l’entreprise, plus bas : un clic sur une entreprise ci-dessous l’ouvre.
          </p>
          {(d?.consultants.length ?? 0) > 8 && (
            <div className="champ" style={{ marginBottom: 12 }}>
              <label htmlFor="rech-consultant">Rechercher un consultant</label>
              <input id="rech-consultant" className="saisie" value={recherche} onChange={(e) => setRecherche(e.target.value)} placeholder="Nom ou email" />
            </div>
          )}
          {reinit && (
            <div className="alerte alerte--info" role="status" style={{ marginBottom: 12 }}>
              <strong>Nouveau mot de passe de {reinit.nom} ({reinit.email}).</strong> Affiché une seule fois, à lui transmettre :{' '}
              <code style={{ fontSize: '1.05rem', userSelect: 'all' }}>{reinit.motDePasse}</code>
            </div>
          )}
          {!d && !erreur && <div className="squelette" style={{ height: 60 }} aria-busy="true" />}
          {d && consultantsVisibles.length === 0 && <p className="texte-discret">Aucun consultant ne correspond.</p>}
          <ul className="pile" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {consultantsVisibles.map((c) => (
              <li key={c.id} className="demande-formation">
                <div className="demande-formation__tete">
                  <strong>{c.nom}</strong>
                  <span className="texte-discret">{c.email} · créé le {c.cree_le.split('-').reverse().join('/')}</span>
                  <span style={{ display: 'flex', gap: 14 }}>
                    <button type="button" className="lien-action" disabled={enCours} onClick={() => reinitialiserMotDePasse(c)}>Nouveau mot de passe</button>
                    <button type="button" className="lien-action" disabled={enCours} onClick={() => reinitialiser2fa(c)}>Réinitialiser la 2FA</button>
                    <button type="button" className="lien-action lien-action--rouge" disabled={enCours} onClick={() => supprimerConsultant(c)}>Supprimer</button>
                  </span>
                </div>
                {c.acces.length === 0
                  ? <span className="texte-discret">Aucun accès pour l’instant.</span>
                  : (
                    <div className="inspection-ligne__badges">
                      {c.acces.map((x) => {
                        const expire = x.fin_le != null && x.fin_le < new Date().toLocaleDateString('sv-SE')
                        return (
                          <a key={x.entreprise_id} href={`#e-${x.entreprise_id}`} className={`badge ${expire ? 'badge--rouge' : x.ecriture ? 'badge--vert' : 'badge--neutre'}`}
                            title={expire ? 'Accès expiré' : undefined}
                            onClick={(ev) => { ev.preventDefault(); const el = document.getElementById(`e-${x.entreprise_id}`); if (el instanceof HTMLDetailsElement) { el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }) } }}>
                            {x.nom} · {x.ecriture ? 'écriture' : 'lecture'}{x.fin_le ? ` · jusqu’au ${x.fin_le.split('-').reverse().join('/')}` : ''}
                          </a>
                        )
                      })}
                    </div>
                  )}
              </li>
            ))}
          </ul>
          {d && consultantsFiltres.length > consultantsVisibles.length && <p className="texte-discret" style={{ marginTop: 10 }}>{consultantsVisibles.length} premiers consultants affichés sur {consultantsFiltres.length} : affinez la recherche.</p>}
        </section>

        <form className="carte" onSubmit={creer} style={{ marginBottom: 24 }}>
          <div className="carte__titre"><h2>Nouveau client</h2></div>
          <div className="grille-2">
            <div className="champ">
              <label htmlFor="n-nom">Raison sociale</label>
              <input id="n-nom" className="saisie" required maxLength={200} value={nouveau.nom} onChange={(e) => setNouveau({ ...nouveau, nom: e.target.value })} />
            </div>
            <div className="champ">
              <label htmlFor="n-pays">Pays</label>
              <select id="n-pays" className="saisie" value={nouveau.pays} onChange={(e) => setNouveau({ ...nouveau, pays: e.target.value })}>
                {pays.map((p) => <option key={p.code} value={p.code}>{p.nom}</option>)}
              </select>
            </div>
            <div className="champ">
              <label htmlFor="n-secteur">Secteur <span className="aide">(facultatif)</span></label>
              <input id="n-secteur" className="saisie" maxLength={120} value={nouveau.secteur} onChange={(e) => setNouveau({ ...nouveau, secteur: e.target.value })} />
            </div>
          </div>
          <fieldset className="fieldset-nu" style={{ marginTop: 14 }}>
            <legend className="label" style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 8 }}>Modules</legend>
            <div className="modules-cases">
              {(d?.modules ?? MODULES_PROSPECT).map((m) => (
                <label key={m} className="case">
                  <input type="checkbox" checked={nouveau.modules.includes(m)}
                    onChange={(e) => setNouveau({ ...nouveau, modules: e.target.checked ? [...nouveau.modules, m] : nouveau.modules.filter((x) => x !== m) })} />
                  {LIBELLE_MODULE[m]}
                </label>
              ))}
            </div>
          </fieldset>
          <p className="texte-discret" style={{ marginTop: 10 }}>
            Après la création, ajoutez ci-dessous un consultant à ce client (son accès n’a pas de durée limitée), puis créez le compte de la personne dans l’onglet « Accès » de l’entreprise.
          </p>
          <button type="submit" className="bouton" disabled={enCours || !nouveau.nom.trim() || nouveau.modules.length === 0} style={{ marginTop: 14 }}><IconePlus /> Créer le client</button>
        </form>

        {!d && !erreur && <div className="squelette" style={{ height: 120 }} aria-busy="true" />}
        <div className="pile">
          {d?.entreprises.map((e) => {
            const a = ajout[e.id] ?? { consultantId: '', ecriture: true }
            const libres = d.consultants.filter((c) => !e.acces.some((x) => x.utilisateur_id === c.id))
            return (
              <details key={e.id} id={`e-${e.id}`} className="carte carte-admin">
                <summary>
                  <span className="inspection-ligne__titre">{e.nom}</span>
                  <span className={`badge ${e.statut_relation === 'prospect' ? 'badge--prospect' : 'badge--vert'}`}>{e.statut_relation === 'prospect' ? 'Prospect' : 'Client'}</span>
                  <span className="badge badge--neutre">{e.acces.length} consultant{e.acces.length > 1 ? 's' : ''}</span>
                </summary>

                <h3 style={{ marginTop: 16 }}>Modules</h3>
                <div className="modules-cases">
                  {d.modules.map((m) => {
                    const actif = e.modules.find((x) => x.module === m)?.actif ?? false
                    const interdit = e.statut_relation === 'prospect' && !MODULES_PROSPECT.includes(m)
                    return (
                      <label key={m} className="case" title={interdit ? 'Réservé aux clients' : undefined}>
                        <input type="checkbox" checked={actif} disabled={enCours || interdit} onChange={(ev) => modifier(e, { action: 'module', module: m, actif: ev.target.checked })} />
                        {LIBELLE_MODULE[m]}
                      </label>
                    )
                  })}
                </div>
                {e.statut_relation === 'prospect' && <p className="texte-discret">Un prospect n’a que les inspections et le tableau de bord. Passez-le en client depuis la Vue d’ensemble pour ouvrir les autres modules.</p>}

                <h3 style={{ marginTop: 16 }}>Consultants ayant accès</h3>
                {e.acces.length === 0 && <p className="texte-discret">Aucun consultant : seul l’administrateur peut entrer dans cette entreprise.</p>}
                <div className="actions" style={{ marginTop: 8 }}>
                  {e.acces.map((x) => (
                    <div key={x.utilisateur_id} className="action">
                      <div>
                        <div className="action__libelle">{x.nom}</div>
                        <div className="action__meta">
                          <span>{x.ecriture ? 'Lecture et écriture' : 'Lecture seule'}</span>
                          {x.fin_le && <span>Jusqu’au {new Date(`${x.fin_le}T12:00:00`).toLocaleDateString('fr-FR')}</span>}
                        </div>
                      </div>
                      <button type="button" className="lien-action lien-action--rouge" disabled={enCours}
                        onClick={() => window.confirm(`Retirer l’accès de ${x.nom} à ${e.nom} ?`) && modifier(e, { action: 'revoquer', consultantId: x.utilisateur_id })}>
                        Retirer
                      </button>
                    </div>
                  ))}
                </div>

                {libres.length > 0 && (
                  <div className="ajout-acces">
                    <select className="saisie" aria-label="Consultant à ajouter" value={a.consultantId} onChange={(ev) => setAjout({ ...ajout, [e.id]: { ...a, consultantId: ev.target.value } })}>
                      <option value="">Ajouter un consultant…</option>
                      {libres.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
                    </select>
                    <label className="case"><input type="checkbox" checked={a.ecriture} onChange={(ev) => setAjout({ ...ajout, [e.id]: { ...a, ecriture: ev.target.checked } })} /> Écriture</label>
                    <button type="button" className="bouton bouton--secondaire bouton--petit" disabled={enCours || !a.consultantId}
                      onClick={async () => { if (await modifier(e, { action: 'acces', ...a })) setAjout({ ...ajout, [e.id]: { consultantId: '', ecriture: true } }) }}>
                      Accorder
                    </button>
                  </div>
                )}
              </details>
            )
          })}
        </div>
      </main>
    </>
  )
}
