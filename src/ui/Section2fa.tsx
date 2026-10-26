'use client'

import { useCallback, useEffect, useState } from 'react'
import ActivationA2f, { CodesSecours } from '@/ui/ActivationA2f'
import { api, messageErreur } from '@/ui/api'

interface Etat { actif: boolean, obligatoire: boolean, codesRestants: number, appareils: number }
type Action = null | 'activer' | 'desactiver' | 'codes'

/** « Mon compte » : état de la double authentification, activation volontaire, codes de secours, appareils de confiance. */
export default function Section2fa() {
  const [etat, setEtat] = useState<Etat | null>(null)
  const [action, setAction] = useState<Action>(null)
  const [code, setCode] = useState('')
  const [motDePasse, setMotDePasse] = useState('')
  const [nouveauxCodes, setNouveauxCodes] = useState<string[] | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)

  const charger = useCallback(() => { api<Etat>('/api/auth/2fa/etat').then(setEtat).catch((e) => setErreur(messageErreur(e))) }, [])
  useEffect(charger, [charger])

  function fermer() { setAction(null); setCode(''); setMotDePasse(''); setErreur(null) }

  async function executer(ev: React.FormEvent) {
    ev.preventDefault()
    setErreur(null)
    setMessage(null)
    setEnCours(true)
    try {
      if (action === 'desactiver') {
        await api('/api/auth/2fa/desactiver', { method: 'POST', corps: { motDePasse, code } })
        setMessage('Double authentification désactivée.')
      } else if (action === 'codes') {
        setNouveauxCodes((await api<{ codesSecours: string[] }>('/api/auth/2fa/codes-secours', { method: 'POST', corps: { code } })).codesSecours)
      }
      fermer()
      charger()
    } catch (e) {
      setErreur(messageErreur(e))
    } finally {
      setEnCours(false)
    }
  }

  async function revoquerAppareils() {
    if (!window.confirm('Retirer la confiance de tous vos appareils ? Le code sera redemandé à la prochaine connexion.')) return
    setErreur(null)
    try {
      await api('/api/auth/2fa/appareils/revoquer', { method: 'POST', corps: {} })
      setMessage('Appareils de confiance retirés.')
      charger()
    } catch (e) { setErreur(messageErreur(e)) }
  }

  return (
    <section className="carte" style={{ maxWidth: 480, marginTop: 24 }}>
      <h2 style={{ marginTop: 0 }}>Double authentification</h2>
      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}
      {message && <div className="alerte alerte--info" role="status" style={{ marginBottom: 14 }}>{message}</div>}
      {!etat && !erreur && <p className="texte-discret">Chargement…</p>}

      {nouveauxCodes && <CodesSecours codes={nouveauxCodes} onFini={() => setNouveauxCodes(null)} libelleBouton="Fermer" />}

      {etat && !nouveauxCodes && (
        <>
          <p style={{ margin: '0 0 12px' }}>
            <span className={`badge ${etat.actif ? 'badge--vert' : 'badge--neutre'}`}>{etat.actif ? 'Activée' : 'Désactivée'}</span>{' '}
            {etat.obligatoire && <span className="badge badge--bleu">Obligatoire pour votre rôle</span>}
          </p>

          {action === 'activer' && <ActivationA2f onActive={() => { fermer(); setMessage('Double authentification activée.'); charger() }} />}

          {(action === 'desactiver' || action === 'codes') && (
            <form onSubmit={executer}>
              {action === 'desactiver' && (
                <div className="champ">
                  <label htmlFor="a2f-mdp">Mot de passe actuel</label>
                  <input id="a2f-mdp" type="password" className="saisie" required autoComplete="current-password" value={motDePasse} onChange={(e) => setMotDePasse(e.target.value)} />
                </div>
              )}
              <div className="champ">
                <label htmlFor="a2f-code">Code à 6 chiffres de l’application</label>
                <input id="a2f-code" className="saisie" inputMode="numeric" autoComplete="one-time-code" required maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                <button type="submit" className={`bouton ${action === 'desactiver' ? 'bouton--danger' : ''}`} disabled={enCours}>
                  {action === 'desactiver' ? 'Désactiver' : 'Générer de nouveaux codes'}
                </button>
                <button type="button" className="bouton bouton--discret" onClick={fermer}>Annuler</button>
              </div>
            </form>
          )}

          {!action && (
            <>
              {!etat.actif && (
                <>
                  <p className="texte-discret">Protège votre compte par un code à usage unique généré sur votre téléphone, en plus du mot de passe.</p>
                  <button type="button" className="bouton" onClick={() => setAction('activer')}>Activer</button>
                </>
              )}
              {etat.actif && (
                <>
                  <p className="texte-discret">{etat.codesRestants} code(s) de secours restant(s) · {etat.appareils} appareil(s) de confiance.</p>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                    <button type="button" className="lien-action" onClick={() => setAction('codes')}>Nouveaux codes de secours</button>
                    {etat.appareils > 0 && <button type="button" className="lien-action" onClick={revoquerAppareils}>Retirer mes appareils de confiance</button>}
                    {!etat.obligatoire && <button type="button" className="lien-action lien-action--rouge" onClick={() => setAction('desactiver')}>Désactiver</button>}
                  </div>
                  {etat.obligatoire && <p className="texte-discret" style={{ marginTop: 10 }}>Obligatoire pour votre rôle : elle ne peut être désactivée que par l’administrateur (en cas de téléphone perdu).</p>}
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
