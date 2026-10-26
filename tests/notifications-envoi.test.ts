import { randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { envoyerEmail, type Courriel } from '@/notifications/email'
import { envoyerFileEmail } from '@/notifications/file'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'

/** Envoi d'e-mail (SMTP, texte brut) et file des notifications : au moins une fois, reports, échec définitif. Rôle propriétaire, comme le script. */

let f: Fixtures
let client: Client
const sujetUnique = `Test envoi ${randomUUID().slice(0, 8)}`

const ajouter = async (destinataire: string, extra: { statut?: string, planifie?: string, tentatives?: number, canal?: string } = {}) =>
  (await client.query(
    `INSERT INTO notification (entreprise_id, canal, destinataire, sujet, corps, statut, tentatives, planifie_le)
     VALUES ($1, $2, $3, $4, 'Corps du test', $5, $6, ${extra.planifie ?? 'now() - interval \'1 minute\''}) RETURNING id`,
    [f.entrepriseA, extra.canal ?? 'email', destinataire, sujetUnique, extra.statut ?? 'en_attente', extra.tentatives ?? 0])).rows[0].id as string
const etat = async (id: string) => (await client.query('SELECT statut, tentatives, erreur, envoye_le, planifie_le > now() AS reporte FROM notification WHERE id = $1', [id])).rows[0]

beforeAll(async () => {
  f = await creerFixtures()
  client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await client.connect()
})
afterAll(async () => {
  await client.query('DELETE FROM notification WHERE sujet = $1', [sujetUnique]).catch(() => {})
  await client.end()
  try { await nettoyerFixtures(f) } catch { /* cf. tenant-isolation.test.ts */ }
})

describe('envoyerEmail (SMTP)', () => {
  it('texte brut seulement, expéditeur configuré, sujet sans saut de ligne ; adresse invalide refusée ; sans SMTP : erreur explicite', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true })
    const captures: Record<string, any>[] = []
    transport.on('sent', () => {})
    const originale = transport.sendMail.bind(transport)
    transport.sendMail = (async (m: any) => { const r = await originale(m); captures.push(JSON.parse((r as { message: string }).message)); return r }) as typeof transport.sendMail
    await envoyerEmail({ a: 'dest@test.local', sujet: 'Ligne 1\r\nBcc: pirate@x.fr', texte: 'Bonjour\nLien : https://exemple.test/x' }, transport)
    expect(captures[0]).toMatchObject({ text: 'Bonjour\nLien : https://exemple.test/x' })
    expect(captures[0]!.html).toBeUndefined()
    expect(captures[0]!.subject).toBe('Ligne 1 Bcc: pirate@x.fr') // injection d'en-tête neutralisée
    expect(captures[0]!.from.address).toBeTruthy()
    await expect(envoyerEmail({ a: 'pas-une-adresse', sujet: 's', texte: 't' }, transport)).rejects.toThrow(/invalide/)
    await expect(envoyerEmail({ a: 'a@b.fr, c@d.fr', sujet: 's', texte: 't' }, transport)).rejects.toThrow(/invalide/)
    const avant = process.env.SMTP_HOST
    delete process.env.SMTP_HOST
    try { await expect(envoyerEmail({ a: 'dest@test.local', sujet: 's', texte: 't' })).rejects.toThrow(/SMTP/) } finally { if (avant) process.env.SMTP_HOST = avant }
  })
})

describe('File des notifications', () => {
  it('envoie les e-mails dus, marque « envoye », ignore les autres canaux, les futurs et les déjà envoyés', async () => {
    const du = await ajouter('du@test.local')
    const futur = await ajouter('futur@test.local', { planifie: "now() + interval '1 hour'" })
    const deja = await ajouter('deja@test.local', { statut: 'envoye' })
    const sms = await ajouter('+22900000000', { canal: 'sms' })
    const envoyes: Courriel[] = []
    const bilan = await envoyerFileEmail(client, async (c) => { if (c.sujet === sujetUnique) envoyes.push(c) }, f.entrepriseA)
    expect(envoyes.map((c) => c.a)).toEqual(['du@test.local'])
    expect(bilan.envoyes).toBeGreaterThanOrEqual(1)
    expect(await etat(du)).toMatchObject({ statut: 'envoye', tentatives: 1, erreur: null })
    expect((await etat(du)).envoye_le).toBeTruthy()
    expect(await etat(futur)).toMatchObject({ statut: 'en_attente', tentatives: 0 })
    expect(await etat(deja)).toMatchObject({ statut: 'envoye', tentatives: 0 })
    expect(await etat(sms)).toMatchObject({ statut: 'en_attente', tentatives: 0 })
    // Rejouer ne renvoie rien : un e-mail envoyé ne repart jamais.
    const reenvoyes: Courriel[] = []
    await envoyerFileEmail(client, async (c) => { if (c.sujet === sujetUnique) reenvoyes.push(c) }, f.entrepriseA)
    expect(reenvoyes).toHaveLength(0)
  })

  it('échec : reporté avec le motif, puis « echec » définitif à la 5e tentative', async () => {
    const id = await ajouter('panne@test.local')
    await envoyerFileEmail(client, async (c) => { if (c.sujet === sujetUnique) throw new Error('connexion refusée') }, f.entrepriseA)
    expect(await etat(id)).toMatchObject({ statut: 'en_attente', tentatives: 1, erreur: 'connexion refusée', reporte: true })
    const derniere = await ajouter('derniere@test.local', { tentatives: 4 })
    const bilan = await envoyerFileEmail(client, async (c) => { if (c.sujet === sujetUnique) throw new Error('boîte inconnue') }, f.entrepriseA)
    expect(await etat(derniere)).toMatchObject({ statut: 'echec', tentatives: 5, erreur: 'boîte inconnue' })
    expect(bilan.echecs).toBeGreaterThanOrEqual(1)
  })

  it('le message d’erreur est tronqué (jamais de contenu de courriel ni de secret en base)', async () => {
    const id = await ajouter('long@test.local')
    await envoyerFileEmail(client, async (c) => { if (c.sujet === sujetUnique) throw new Error('x'.repeat(2000)) }, f.entrepriseA)
    expect((await etat(id)).erreur.length).toBe(300)
  })
})
