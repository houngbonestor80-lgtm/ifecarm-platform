import { traiterDemandeReinitialisation } from '@/auth/routes'

export const POST = (request: Request) => traiterDemandeReinitialisation(request)
