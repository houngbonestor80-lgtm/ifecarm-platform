import { headers } from 'next/headers'
import { sql } from 'kysely'
import { withoutTenant } from '@/db/tenant'
import { dateFr } from '@/ui/libelles'

/**
 * Page publique, sans compte : vérifie une attestation à partir du code porté
 * par son QR. Passe par verifier_attestation (SECURITY DEFINER), qui journalise
 * la consultation et ne renvoie que les champs affichables.
 */

export const metadata = { title: 'Vérification d’attestation — IFECARM GROUP', robots: { index: false, follow: false } }

const CODE = /^[A-Za-z0-9_-]{8,64}$/

export default async function PageVerification({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1'
  const a = CODE.test(code)
    ? (await withoutTenant((trx) => sql<{
        nom_salarie: string, prenom_salarie: string, intitule_formation: string, nom_entreprise: string,
        date_fin: Date, expire_le: Date | null, statut: string,
      }>`select * from verifier_attestation(${code}, ${ip})`.execute(trx))).rows[0]
    : undefined
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
  const expiree = a?.expire_le ? a.expire_le.getTime() < Date.now() : false
  const valide = a?.statut === 'valide' && !expiree

  return (
    <main className="contenu contenu--etroit" style={{ paddingTop: 40 }}>
      <h1>Vérification d’attestation</h1>
      {!a && <div className="alerte alerte--erreur" role="alert">Aucune attestation ne correspond à ce code.</div>}
      {a && (
        <section className="carte">
          <div className={`alerte ${valide ? 'alerte--info' : 'alerte--erreur'}`} role="status" style={{ marginBottom: 14 }}>
            {a.statut === 'annulee' ? 'Attestation annulée.' : expiree ? 'Attestation expirée.' : 'Attestation authentique et valide.'}
          </div>
          <p><strong>{a.prenom_salarie} {a.nom_salarie}</strong> — {a.nom_entreprise}</p>
          <p>{a.intitule_formation}</p>
          <p className="texte-discret">Formation terminée le {dateFr(iso(a.date_fin))}{a.expire_le && ` · valable jusqu’au ${dateFr(iso(a.expire_le))}`}</p>
        </section>
      )}
      <p className="texte-discret" style={{ marginTop: 20 }}>IFECARM GROUP</p>
    </main>
  )
}
