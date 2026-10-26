import { traiterAjoutNote, traiterListeNotes } from '@/notes/routes'

export const GET = (request: Request) => traiterListeNotes(request)
export const POST = (request: Request) => traiterAjoutNote(request)
