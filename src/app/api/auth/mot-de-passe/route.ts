import { traiterChangementMotDePasse } from '@/auth/routes'

export const POST = (request: Request) => traiterChangementMotDePasse(request)
