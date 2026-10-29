import { dateFr } from '@/ui/libelles'

/** Messages prérédigés des relances de vente (WhatsApp, e-mail) : le consultant les relit et les envoie lui-même. */

export interface ObjetRelance {
  type: 'recyclage' | 'habilitation' | 'verification'
  libelle: string, nb: number, premiere_echeance: string, echues: number, entreprise_nom: string, contact_nom: string | null
}

const pluriel = (n: number, s: string, p = `${s}s`) => `${n} ${n > 1 ? p : s}`

export function messageRelance(o: ObjetRelance): string {
  const salaries = pluriel(o.nb, 'salarié')
  const quand = o.echues > 0
    ? (o.echues === o.nb ? `sont échues depuis le ${dateFr(o.premiere_echeance)}` : `arrivent à échéance (${o.echues} déjà échue${o.echues > 1 ? 's' : ''} depuis le ${dateFr(o.premiere_echeance)})`)
    : `arrivent à échéance à partir du ${dateFr(o.premiere_echeance)}`
  const corps = {
    recyclage: `Les attestations « ${o.libelle} » de ${salaries} de ${o.entreprise_nom} ${quand}. Pour rester en règle, nous vous proposons d'organiser le recyclage avant cette date, dans vos locaux ou dans les nôtres. Quelles dates vous conviendraient ?`,
    habilitation: `Les habilitations « ${o.libelle} » de ${salaries} de ${o.entreprise_nom} ${quand}. Nous pouvons organiser leur renouvellement (formation et évaluation). Voulez-vous que nous planifiions une session ?`,
    verification: `${pluriel(o.nb, 'équipement')} « ${o.libelle} » de ${o.entreprise_nom} ${o.echues > 0 ? 'ont dépassé leur date de vérification' : `doivent être vérifiés à partir du ${dateFr(o.premiere_echeance)}`}. Nous pouvons réaliser ces vérifications périodiques et vous remettre le rapport. Quand pouvons-nous passer ?`,
  }[o.type]
  return `Bonjour${o.contact_nom ? ` ${o.contact_nom}` : ''},\n\nIci IFECARM GROUP. ${corps}\n\nBien cordialement,\nIFECARM GROUP`
}

export const sujetRelance = (o: ObjetRelance) =>
  ({ recyclage: 'Recyclage à prévoir', habilitation: 'Habilitations à renouveler', verification: 'Vérifications périodiques à prévoir' }[o.type] + ` — ${o.libelle}`)
