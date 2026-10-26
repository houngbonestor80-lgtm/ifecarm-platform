'use client'

import { useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { IconeCoche } from '@/ui/icones'

interface Enrolement { secret: string, uri: string, qr: string }

/** Les 10 codes de secours, affichés UNE SEULE FOIS (le serveur n'en garde que l'empreinte). */
export function CodesSecours({ codes, onFini, libelleBouton = 'J’ai conservé mes codes' }: { codes: string[], onFini: () => void, libelleBouton?: string }) {
  const [conserves, setConserves] = useState(false)
  const texte = codes.join('\n')
  function telecharger() {
    const lien = document.createElement('a')
    lien.href = URL.createObjectURL(new Blob([`IFECARM GROUP — codes de secours (usage unique)\n\n${texte}\n`], { type: 'text/plain' }))
    lien.download = 'ifecarm-codes-de-secours.txt'
    lien.click()
    URL.revokeObjectURL(lien.href)
  }
  return (
    <div>
      <div className="alerte alerte--attention" role="status">
        <strong>Conservez ces 10 codes de secours.</strong> Chacun ne sert qu’une fois, si vous perdez votre téléphone. Ils ne seront plus affichés.
      </div>
      <pre className="saisie" style={{ marginTop: 14, fontSize: '1.05rem', lineHeight: 1.7, letterSpacing: '0.06em', textAlign: 'center', userSelect: 'all' }}>{texte}</pre>
      <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" className="bouton bouton--secondaire bouton--petit" onClick={() => navigator.clipboard?.writeText(texte)}>Copier</button>
        <button type="button" className="bouton bouton--secondaire bouton--petit" onClick={telecharger}>Télécharger</button>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16 }}>
        <input type="checkbox" checked={conserves} onChange={(e) => setConserves(e.target.checked)} /> Je les ai enregistrés dans un endroit sûr.
      </label>
      <button type="button" className="bouton" style={{ marginTop: 14 }} disabled={!conserves} onClick={onFini}><IconeCoche /> {libelleBouton}</button>
    </div>
  )
}

/**
 * Activation de la double authentification : QR code (ou clé à saisir), puis premier code pour confirmer, puis codes de secours.
 * Sert à la connexion (rôles obligatoires) et depuis « Mon compte » (activation volontaire).
 */
export default function ActivationA2f({ onActive }: { onActive: () => void }) {
  const [enrolement, setEnrolement] = useState<Enrolement | null>(null)
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)

  async function demarrer() {
    setErreur(null)
    setEnCours(true)
    try { setEnrolement(await api<Enrolement>('/api/auth/2fa/activation/demarrer', { method: 'POST', corps: {} })) } catch (e) { setErreur(messageErreur(e)) } finally { setEnCours(false) }
  }
  async function confirmer(ev: React.FormEvent) {
    ev.preventDefault()
    setErreur(null)
    setEnCours(true)
    try {
      const r = await api<{ codesSecours: string[] }>('/api/auth/2fa/activation/confirmer', { method: 'POST', corps: { code } })
      setCodes(r.codesSecours)
    } catch (e) { setErreur(messageErreur(e)) } finally { setEnCours(false) }
  }

  if (codes) return <CodesSecours codes={codes} onFini={onActive} libelleBouton="Terminer" />

  return (
    <div>
      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}
      {!enrolement ? (
        <>
          <p className="texte-discret">Il vous faut une application d’authentification sur votre téléphone (Google Authenticator, Microsoft Authenticator, Authy, FreeOTP…).</p>
          <button type="button" className="bouton" style={{ marginTop: 14 }} disabled={enCours} onClick={demarrer}>Commencer l’activation</button>
        </>
      ) : (
        <form onSubmit={confirmer}>
          <ol style={{ paddingLeft: 18, margin: '0 0 14px', lineHeight: 1.6 }}>
            <li>Dans l’application, ajoutez un compte et scannez ce code.</li>
            <li>Saisissez ci-dessous le code à 6 chiffres qu’elle affiche.</li>
          </ol>
          <div style={{ textAlign: 'center' }}>
            {/* Image de données générée par le serveur : aucun service externe ne voit le secret. */}
            <img src={enrolement.qr} alt="QR code d’activation" width={200} height={200} style={{ background: '#fff', padding: 8, borderRadius: 8 }} />
            <p className="texte-discret" style={{ marginTop: 8 }}>Impossible de scanner ? Saisissez cette clé :<br /><code style={{ userSelect: 'all', wordBreak: 'break-all' }}>{enrolement.secret}</code></p>
          </div>
          <div className="champ">
            <label htmlFor="a2f-code">Code à 6 chiffres</label>
            <input id="a2f-code" className="saisie" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required
              value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <button type="submit" className="bouton" style={{ marginTop: 14 }} disabled={enCours}><IconeCoche /> Activer</button>
        </form>
      )}
    </div>
  )
}
