import { classeScore, couleurBarre } from '@/autodiagnostic/classes'
import { lireResultat } from '@/mini-audit/service'
import { dateFr } from '@/ui/libelles'

/**
 * Résultat public d'un mini-audit, pour qui détient le code de suivi (lien de l'e-mail). Passe par lire_mini_audit
 * (SECURITY DEFINER), qui ne renvoie ni l'e-mail ni le téléphone.
 */

export const metadata = { title: 'Résultat du mini-audit QHSE — IFECARM GROUP', robots: { index: false, follow: false } }

export default async function PageResultatMiniAudit({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const m = await lireResultat(decodeURIComponent(code))
  const r = m?.resultat

  return (
    <main className="page-centree" style={{ alignItems: 'start' }}>
      <div className="carte-centree" style={{ maxWidth: 720 }}>
        <div className="carte-centree__logo" style={{ marginBottom: 18 }}>
          <img src="/brand/logo-circle.svg" alt="IFECARM GROUP" />
          <div>
            <div className="marque__nom">IFECARM GROUP</div>
            <div className="marque__sous">Conseil QHSE · Cotonou et Paris</div>
          </div>
        </div>
        {!m || !r ? (
          <>
            <h1>Résultat introuvable</h1>
            <div className="alerte alerte--erreur" role="alert">Aucun mini-audit ne correspond à ce code de suivi.</div>
            <p style={{ marginTop: 16 }}><a className="bouton" href="/mini-audit">Faire le mini-audit</a></p>
          </>
        ) : (
          <>
            <h1>{m.referentiel_titre}</h1>
            <p className="sous-titre">{m.entreprise_nom} · {dateFr(m.cree_le.toISOString().slice(0, 10))} · code de suivi <strong>{m.code_suivi}</strong></p>

            <section className="tuiles" aria-label="Résultat" style={{ margin: '16px 0' }}>
              <div className={`tuile ${r.globalScore >= 80 ? 'tuile--vert' : r.globalScore >= 60 ? 'tuile--bleu' : r.globalScore >= 40 ? 'tuile--orange' : 'tuile--rouge'}`}>
                <div className="tuile__valeur">{r.globalScore} %</div>
                <div className="tuile__libelle">Score global</div>
              </div>
              <div className="tuile tuile--bleu"><div className="tuile__valeur" style={{ fontSize: '1.3rem' }}>{r.niveau.libelle}</div><div className="tuile__libelle">Niveau</div></div>
            </section>
            <p>{r.niveau.message}</p>

            <h2 style={{ margin: '20px 0 12px' }}>Scores par thème</h2>
            <div style={{ display: 'grid', gap: 12 }}>
              {r.themes.map((t) => (
                <div key={t.code}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
                    <strong>{t.libelle}</strong><span className={`badge ${classeScore(t.score)}`}>{t.score} %</span>
                  </div>
                  <div className="progression__barre" role="img" aria-label={`${t.libelle} : ${t.score} %`}><div className="progression__remplissage" style={{ width: `${t.score}%`, background: couleurBarre(t.score) }} /></div>
                </div>
              ))}
            </div>

            <h2 style={{ marginTop: 20 }}>Vos priorités</h2>
            {r.recommendations.length === 0 && <p>Aucun écart déclaré : bravo. Un audit externe confirmerait ce niveau.</p>}
            <ol style={{ display: 'grid', gap: 8, paddingLeft: 20 }}>
              {r.recommendations.slice(0, 5).map((x) => <li key={x.questionId}><strong>{x.themeLibelle}</strong> : {x.texte}</li>)}
            </ol>

            <div className="alerte alerte--info" style={{ marginTop: 20 }}>
              <div>
                Un consultant IFECARM GROUP va vous contacter pour commenter ce résultat et vous proposer un diagnostic sur site.
                Gardez votre code de suivi <strong>{m.code_suivi}</strong> : il vous permet de retrouver cette page.
              </div>
            </div>
            <p className="texte-discret" style={{ marginTop: 14 }}>{m.avertissement}</p>
          </>
        )}
      </div>
    </main>
  )
}
