'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { useContexteApp } from '@/ui/CadreApplication'
import { IconeBouclier, IconeCoche, IconePersonne, IconePlus } from '@/ui/icones'

interface Compte {
  id: string
  nom: string
  email: string
  telephone: string | null
  actif: boolean
  derniere_connexion: string | null
  roles: string[]
}

const ROLES: { valeur: string, texte: string, aide: string }[] = [
  { valeur: 'admin_entreprise', texte: 'Administrateur', aide: 'Dirigeant ou référent : voit tout, gère le registre des équipements.' },
  { valeur: 'responsable_qhse', texte: 'Responsable QHSE', aide: 'Suit les inspections, non-conformités et plans d’action.' },
  { valeur: 'responsable_site', texte: 'Responsable de site', aide: 'Suit son site et le registre des équipements.' },
  { valeur: 'declarant', texte: 'Déclarant', aide: 'Consulte et met à jour les actions qui le concernent.' },
]
const libelleRole = (r: string) => ROLES.find((x) => x.valeur === r)?.texte ?? r

export default function PageAcces() {
  const { entreprise, peutConduire } = useContexteApp()
  const [comptes, setComptes] = useState<Compte[] | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [form, setForm] = useState<{ nom: string, email: string, role: string } | null>(null)
  const [secret, setSecret] = useState<{ nom: string, email: string, motDePasse: string } | null>(null)
  const [enCours, setEnCours] = useState(false)

  const charger = useCallback(() => {
    api<{ comptes: Compte[] }>('/api/comptes').then((r) => setComptes(r.comptes)).catch((e) => setErreur(messageErreur(e)))
  }, [])
  useEffect(() => { if (peutConduire) charger() }, [charger, peutConduire])

  async function agir<T>(fn: () => Promise<T>): Promise<T | null> {
    setErreur(null)
    setEnCours(true)
    try {
      const r = await fn()
      charger()
      return r
    } catch (e) {
      setErreur(messageErreur(e))
      return null
    } finally {
      setEnCours(false)
    }
  }

  async function creer(ev: React.FormEvent) {
    ev.preventDefault()
    if (!form) return
    const r = await agir(() => api<{ motDePasse: string }>('/api/comptes', { method: 'POST', corps: form }))
    if (r) {
      setSecret({ nom: form.nom, email: form.email, motDePasse: r.motDePasse })
      setForm(null)
    }
  }

  async function reinitialiser(c: Compte) {
    if (!window.confirm(`Générer un nouveau mot de passe pour ${c.nom} ? L’ancien ne fonctionnera plus et ses sessions seront fermées.`)) return
    const r = await agir(() => api<{ motDePasse: string }>(`/api/comptes/${c.id}`, { method: 'PATCH', corps: { action: 'mot_de_passe' } }))
    if (r) setSecret({ nom: c.nom, email: c.email, motDePasse: r.motDePasse })
  }

  if (!peutConduire) {
    return (
      <main className="contenu contenu--etroit">
        <div className="alerte alerte--info">La gestion des accès est réservée à votre consultant IFECARM GROUP.</div>
      </main>
    )
  }

  return (
    <main className="contenu contenu--etroit">
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">Accès à la plateforme</div>
          <h1>{entreprise.nom}</h1>
          <p className="tete-page__desc">
            Seules les personnes inscrites ici peuvent se connecter, et chacune ne voit que les informations de {entreprise.nom}.
          </p>
        </div>
        {!form && <button type="button" className="bouton" onClick={() => { setForm({ nom: '', email: '', role: 'admin_entreprise' }); setSecret(null) }}><IconePlus /> Nouveau compte</button>}
      </div>

      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}

      {secret && (
        <div className="carte encadre-secret" role="status">
          <div className="carte__titre"><h2><IconeBouclier /> Mot de passe provisoire</h2></div>
          <p>Transmettez ces identifiants à <strong>{secret.nom}</strong> par un canal sûr (en main propre, par téléphone). <strong>Ce mot de passe ne sera plus affiché.</strong></p>
          <dl className="identifiants">
            <dt>Adresse de connexion</dt><dd>{typeof window !== 'undefined' ? `${window.location.origin}/connexion` : '/connexion'}</dd>
            <dt>Email</dt><dd>{secret.email}</dd>
            <dt>Mot de passe</dt><dd className="identifiants__mdp">{secret.motDePasse}</dd>
          </dl>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
            <button type="button" className="bouton bouton--secondaire" onClick={() => navigator.clipboard?.writeText(
              `Plateforme QHSE IFECARM GROUP\nAdresse : ${window.location.origin}/connexion\nEmail : ${secret.email}\nMot de passe : ${secret.motDePasse}`)}>
              Copier les identifiants
            </button>
            <button type="button" className="bouton" onClick={() => setSecret(null)}><IconeCoche /> C’est transmis</button>
          </div>
        </div>
      )}

      {form && (
        <form className="carte" onSubmit={creer} style={{ marginBottom: 20 }}>
          <div className="carte__titre"><h2>Nouveau compte</h2></div>
          <div className="grille-2">
            <div className="champ">
              <label htmlFor="c-nom">Nom et prénom</label>
              <input id="c-nom" className="saisie" required maxLength={200} value={form.nom} onChange={(e) => setForm({ ...form, nom: e.target.value })} />
            </div>
            <div className="champ">
              <label htmlFor="c-email">Email</label>
              <input id="c-email" type="email" className="saisie" required maxLength={254} autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
          </div>
          <fieldset className="choix" style={{ marginTop: 16 }}>
            <legend className="label" style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 8 }}>Rôle</legend>
            {ROLES.map((r) => (
              <label key={r.valeur} className="choix__option">
                <input type="radio" name="role" value={r.valeur} checked={form.role === r.valeur} onChange={() => setForm({ ...form, role: r.valeur })} />
                <span><span className="choix__titre">{r.texte}</span><span className="choix__meta">{r.aide}</span></span>
              </label>
            ))}
          </fieldset>
          <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
            <button type="submit" className="bouton" disabled={enCours}><IconeCoche /> Créer le compte</button>
            <button type="button" className="bouton bouton--secondaire" onClick={() => setForm(null)}>Annuler</button>
          </div>
        </form>
      )}

      {!comptes && !erreur && <div className="squelette" style={{ height: 96 }} aria-busy="true" />}
      {comptes?.length === 0 && !form && (
        <div className="vide">
          <IconePersonne />
          <h2>Aucun compte pour l’instant</h2>
          <p>Créez le compte d’une personne de {entreprise.nom} pour qu’elle suive ses inspections et ses plans d’action.</p>
        </div>
      )}

      <div className="inspections">
        {comptes?.map((c) => (
          <div key={c.id} className="inspection-ligne">
            <div>
              <div className="inspection-ligne__titre">{c.nom}</div>
              <div className="inspection-ligne__meta"><span>{c.email}</span></div>
              <div className="inspection-ligne__badges">
                {c.actif ? <span className="badge badge--vert">Actif</span> : <span className="badge badge--neutre">Désactivé</span>}
                {c.roles.map((r) => <span key={r} className="badge badge--bleu">{libelleRole(r)}</span>)}
                <span className="badge badge--neutre">
                  {c.derniere_connexion ? `Dernière connexion : ${new Date(c.derniere_connexion).toLocaleDateString('fr-FR')}` : 'Jamais connecté'}
                </span>
              </div>
            </div>
            <div className="equipement-actions">
              {c.actif && <button type="button" className="lien-action" disabled={enCours} onClick={() => reinitialiser(c)}>Nouveau mot de passe</button>}
              <button type="button" className={`lien-action ${c.actif ? 'lien-action--rouge' : ''}`} disabled={enCours}
                onClick={() => (c.actif ? window.confirm(`Désactiver le compte de ${c.nom} ? Il sera déconnecté immédiatement.`) : true)
                  && agir(() => api(`/api/comptes/${c.id}`, { method: 'PATCH', corps: { actif: !c.actif } }))}>
                {c.actif ? 'Désactiver' : 'Réactiver'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </main>
  )
}
