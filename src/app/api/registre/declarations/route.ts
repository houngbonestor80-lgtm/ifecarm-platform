import { traiterDeclaration, traiterListe } from '@/registre/routes'

export const GET = (request: Request) => traiterListe(request)
export const POST = (request: Request) => traiterDeclaration(request)
