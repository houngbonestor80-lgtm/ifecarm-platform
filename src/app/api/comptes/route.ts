import { traiterCreationCompte, traiterListeComptes } from '@/acces/routes'

export const GET = (request: Request) => traiterListeComptes(request)
export const POST = (request: Request) => traiterCreationCompte(request)
