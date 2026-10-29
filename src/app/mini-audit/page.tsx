'use client'

import { useEffect, useMemo, useState } from 'react'

/**
 * Mini-audit QHSE gratuit, PUBLIC (sans compte) : questions thème par thème, coordonnées, puis page de résultat avec
 * code de suivi. Le score est calculé par la base à l'envoi (migration 0052), jamais par ce navigateur.
 */

interface Question { id: string, texte: string, aide?: string | null }
interface Theme { code: string, libelle: string, questions: Question[] }
interface Questionnaire {
  code: string, titre: string, description: string, duree_estimee_minutes: number, avertissement: string,
  definition: { echelleReponses: { code: string, libelle: string, coefficient: number }[], themes: Theme[] }
}

const EFFECTIFS = [['1-9', '1 à 9'], ['10-49', '10 à 49'], ['50-249', '50 à 249'], ['250+', '250 et plus']] as const
const couleurReponse = (c: number) => (c >= 1 ? 'var(--brand-600)' : c > 0 ? 'var(--qhse-orange)' : 'var(--qhse-red)')

function EnTete() {
  return (
    <div className="carte-centree__logo" style={{ marginBottom: 18 }}>
      <img src="/brand/logo-circle.svg" alt="IFECARM GROUP" />
      <div>
        <div className="marque__nom">IFECARM GROUP</div>
        <div className="marque__sous">Conseil QHSE · Cotonou et Paris</div>
      </div>
    </div>
  )
}

export default function PageMiniAudit() {
  const [donnees, setDonnees] = useState<{ questionnaires: Questionnaire[], pays: { code: string, nom: string }[] } | null>(null)
  const [choix, setChoix] = useState<string | null>(null)
  const [etape, setEtape] = useState(-1) // -1 : accueil ; 0..n-1 : thèmes ; n : coordonnées
  const [reponses, setReponses] = useState<Record<string, string>>({})
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)

  useEffect(() => {
    fetch('/api/mini-audit').then((r) => r.json()).then((d) => {
      setDonnees(d)
      if (d.questionnaires?.length === 1) setChoix(d.questionnaires[0].code)
    }).catch(() => setErreur('Chargement impossible. Vérifiez votre connexion.'))
  }, [])

  const q = useMemo(() => donnees?.questionnaires.find((x) => x.code === choix) ?? null, [donnees, choix])
  const themes = q?.definition.themes ?? []
  const total = themes.reduce((n, t) => n + t.questions.length, 0)
  const repondues = Object.keys(reponses).length
  const theme = etape >= 0 && etape < themes.length ? themes[etape] : null

  const suivant = () => {
    if (theme && theme.questions.some((x) => !reponses[x.id])) return setErreur('Répondez à toutes les questions de ce thème.')
    setErreur(null)
    setEtape(etape + 1)
    window.scrollTo({ top: 0 })
  }

  async function envoyer(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setErreur(null)
    setEnCours(true)
    const d = new FormData(e.currentTarget)
    const champ = (n: string) => String(d.get(n) ?? '')
    try {
      const r = await fetch('/api/mini-audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          questionnaire: choix, reponses, siteWeb: champ('siteWeb'),
          contact: {
            nom: champ('nom'), fonction: champ('fonction'), entreprise: champ('entreprise'), email: champ('email'), telephone: champ('telephone'),
            pays: champ('pays'), secteur: champ('secteur'), effectif: champ('effectif'), consentement: d.get('consentement') === 'on',
          },
        }),
      })
      const corps = await r.json().catch(() => ({}))
      if (!r.ok) return setErreur(corps.erreur ?? 'Envoi impossible.')
      window.location.assign(`/mini-audit/${corps.code}`)
    } catch {
      setErreur('Envoi impossible. Vérifiez votre connexion.')
    } finally {
      setEnCours(false)
    }
  }

  return (
    <main className="page-centree" style={{ alignItems: 'start' }}>
      <div className="carte-centree" style={{ maxWidth: 720 }}>
        <EnTete />
        {!donnees && !erreur && <p className="texte-discret">Chargement…</p>}
        {donnees && !donnees.questionnaires.length && <p>Le mini-audit n’est pas disponible pour le moment.</p>}

        {/* Accueil */}
        {donnees && etape === -1 && donnees.questionnaires.length > 0 && (
          <>
            <h1>Mini-audit QHSE gratuit</h1>
            <p className="sous-titre">Situez votre entreprise en quelques minutes : score immédiat, priorités d’action et rappel d’un consultant.</p>
            <div style={{ display: 'grid', gap: 10, margin: '18px 0' }}>
              {donnees.questionnaires.map((x) => (
                <label key={x.code} className="point" style={{ cursor: 'pointer', borderLeftColor: choix === x.code ? 'var(--brand-600)' : undefined }}>
                  <div className="point__tete">
                    <input type="radio" name="questionnaire" checked={choix === x.code} onChange={() => setChoix(x.code)} />
                    <div>
                      <div className="point__libelle">{x.titre}</div>
                      <div className="point__aide">{x.description} Environ {x.duree_estimee_minutes} minutes.</div>
                    </div>
                  </div>
                </label>
              ))}
            </div>
            <button type="button" className="bouton bouton--bloc" disabled={!choix} onClick={() => { setReponses({}); setEtape(0) }}>Commencer</button>
            <p className="texte-discret" style={{ marginTop: 12 }}>Gratuit et sans engagement. Vos réponses restent confidentielles.</p>
          </>
        )}

        {/* Questions, un thème par écran */}
        {q && theme && (
          <>
            <div className="progression" style={{ marginBottom: 14 }}>
              <div className="progression__texte">Thème {etape + 1} sur {themes.length} · {repondues}/{total} réponses</div>
              <div className="progression__barre"><div className="progression__remplissage" style={{ width: `${Math.round((repondues / total) * 100)}%` }} /></div>
            </div>
            <h2>{theme.libelle}</h2>
            <ol style={{ listStyle: 'none', padding: 0, margin: '12px 0', display: 'grid', gap: 12 }}>
              {theme.questions.map((x) => {
                const rep = reponses[x.id]
                const coef = q.definition.echelleReponses.find((e) => e.code === rep)?.coefficient
                return (
                  <li key={x.id} className="point" style={{ borderLeftColor: coef !== undefined ? couleurReponse(coef) : undefined }}>
                    <div className="point__libelle">{x.texte}</div>
                    {x.aide && <div className="point__aide">{x.aide}</div>}
                    <div className="verdict" role="group" aria-label={`Réponse : ${x.texte}`} style={{ marginTop: 10, gridTemplateColumns: `repeat(${Math.min(q.definition.echelleReponses.length, 4)}, 1fr)` }}>
                      {q.definition.echelleReponses.map((e) => (
                        <button key={e.code} type="button" aria-pressed={rep === e.code}
                          style={rep === e.code ? { background: couleurReponse(e.coefficient), borderColor: couleurReponse(e.coefficient), color: '#fff' } : undefined}
                          onClick={() => setReponses({ ...reponses, [x.id]: e.code })}>
                          <span className="libelle">{e.libelle}</span>
                        </button>
                      ))}
                    </div>
                  </li>
                )
              })}
            </ol>
            {erreur && <div className="alerte alerte--erreur" role="alert">{erreur}</div>}
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button type="button" className="bouton bouton--secondaire" onClick={() => { setErreur(null); setEtape(etape - 1) }}>Retour</button>
              <button type="button" className="bouton" style={{ flex: 1 }} onClick={suivant}>{etape + 1 < themes.length ? 'Thème suivant' : 'Voir mon résultat'}</button>
            </div>
          </>
        )}

        {/* Coordonnées */}
        {q && donnees && etape === themes.length && (
          <form method="post" onSubmit={envoyer}>
            <h2>Dernière étape : vos coordonnées</h2>
            <p className="sous-titre">Votre résultat s’affiche juste après et vous est envoyé par e-mail.</p>
            <div className="grille-2">
              <div className="champ"><label htmlFor="nom">Nom et prénom</label><input id="nom" name="nom" className="saisie" required maxLength={200} autoComplete="name" /></div>
              <div className="champ"><label htmlFor="fonction">Fonction <span className="aide">(facultatif)</span></label><input id="fonction" name="fonction" className="saisie" maxLength={200} autoComplete="organization-title" /></div>
              <div className="champ"><label htmlFor="entreprise">Entreprise</label><input id="entreprise" name="entreprise" className="saisie" required maxLength={200} autoComplete="organization" /></div>
              <div className="champ"><label htmlFor="email">E-mail professionnel</label><input id="email" name="email" type="email" className="saisie" required maxLength={200} autoComplete="email" /></div>
              <div className="champ"><label htmlFor="telephone">Téléphone / WhatsApp <span className="aide">(facultatif)</span></label><input id="telephone" name="telephone" type="tel" className="saisie" maxLength={30} autoComplete="tel" placeholder="+229 01 00 00 00 00" /></div>
              <div className="champ">
                <label htmlFor="pays">Pays</label>
                <select id="pays" name="pays" className="saisie" required defaultValue="BJ">
                  {donnees.pays.map((p) => <option key={p.code} value={p.code}>{p.nom}</option>)}
                </select>
              </div>
              <div className="champ"><label htmlFor="secteur">Secteur d’activité <span className="aide">(facultatif)</span></label><input id="secteur" name="secteur" className="saisie" maxLength={200} placeholder="BTP, industrie, logistique…" /></div>
              <div className="champ">
                <label htmlFor="effectif">Effectif <span className="aide">(facultatif)</span></label>
                <select id="effectif" name="effectif" className="saisie" defaultValue="">
                  <option value="">—</option>
                  {EFFECTIFS.map(([v, t]) => <option key={v} value={v}>{t} salariés</option>)}
                </select>
              </div>
            </div>
            {/* Champ piège, invisible pour un humain. */}
            <div className="visually-hidden" aria-hidden="true"><label htmlFor="siteWeb">Site web</label><input id="siteWeb" name="siteWeb" tabIndex={-1} autoComplete="off" /></div>
            <label className="case" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12 }}>
              <input type="checkbox" name="consentement" required />
              <span>J’accepte qu’IFECARM GROUP conserve ces informations pour m’envoyer mon résultat et me recontacter au sujet de ce diagnostic.</span>
            </label>
            {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginTop: 14 }}>{erreur}</div>}
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button type="button" className="bouton bouton--secondaire" onClick={() => setEtape(etape - 1)}>Retour</button>
              <button type="submit" className="bouton" style={{ flex: 1 }} disabled={enCours}>{enCours ? 'Calcul…' : 'Obtenir mon résultat'}</button>
            </div>
            <p className="texte-discret" style={{ marginTop: 12 }}>{q.avertissement}</p>
          </form>
        )}
        {erreur && etape === -1 && <div className="alerte alerte--erreur" role="alert">{erreur}</div>}
      </div>
    </main>
  )
}
