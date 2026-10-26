import { traiterCreationAutodiagnostic, traiterListeAutodiagnostics } from '@/autodiagnostic/routes'

export const GET = (request: Request) => traiterListeAutodiagnostics(request)
export const POST = (request: Request) => traiterCreationAutodiagnostic(request)
