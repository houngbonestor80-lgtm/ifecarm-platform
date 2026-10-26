import nodemailer, { type Transporter } from 'nodemailer'

/**
 * Envoi d'e-mail par SMTP : tout fournisseur (Brevo, Scaleway, SES…) se branche en renseignant SMTP_* dans .env ;
 * en local, Mailpit (docker compose) reçoit tout sans rien envoyer. Texte brut seulement (pas de HTML : rien à
 * injecter, lisible partout). Le contenu des messages n'est JAMAIS journalisé (liens de réinitialisation compris).
 */

export class EmailNonConfigure extends Error {
  constructor() {
    super('Aucun serveur SMTP configuré (SMTP_HOST).')
  }
}

export const emailConfigure = () => Boolean(process.env.SMTP_HOST)

let transportParDefaut: Transporter | null = null

function creerTransportSmtp(): Transporter {
  const host = process.env.SMTP_HOST
  if (!host) throw new EmailNonConfigure()
  const user = process.env.SMTP_USER
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    // Avec identifiants (fournisseur réel), le chiffrement STARTTLS est exigé : jamais de mot de passe SMTP en clair.
    requireTLS: process.env.SMTP_SECURE !== 'true' && Boolean(user),
    auth: user ? { user, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  })
}

export interface Courriel { a: string, sujet: string, texte: string }

const ADRESSE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/

/** `transport` : injecté par les tests ; sinon le SMTP configuré. Lève EmailNonConfigure s'il n'y en a pas. */
export async function envoyerEmail(courriel: Courriel, transport?: Transporter): Promise<void> {
  if (!ADRESSE.test(courriel.a)) throw new Error('Adresse e-mail invalide.')
  const t = transport ?? (transportParDefaut ??= creerTransportSmtp())
  await t.sendMail({
    from: process.env.SMTP_FROM ?? 'IFECARM GROUP <no-reply@ifecarm-qhse.com>',
    to: courriel.a,
    subject: courriel.sujet.replace(/[\r\n]+/g, ' ').slice(0, 200),
    text: courriel.texte,
  })
}

/** Adresse publique de la plateforme pour les liens des e-mails. */
export const urlPublique = () => (process.env.APP_URL ?? 'http://localhost:3001').replace(/\/+$/, '')
