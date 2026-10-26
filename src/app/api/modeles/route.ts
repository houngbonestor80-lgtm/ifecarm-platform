import { traiterCreationModele, traiterListeModeles } from '@/modeles/routes'

export const GET = (request: Request) => traiterListeModeles(request)
export const POST = (request: Request) => traiterCreationModele(request)
