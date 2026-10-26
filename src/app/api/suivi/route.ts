import { traiterAjoutNote, traiterListeNotes } from '@/suivi/routes'

export const GET = (request: Request) => traiterListeNotes(request)
export const POST = (request: Request) => traiterAjoutNote(request)
