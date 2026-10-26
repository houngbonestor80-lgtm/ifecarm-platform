import { traiterCatalogueAutodiagnostic, traiterCreationReferentiel } from '@/autodiagnostic/routes'

export const GET = (request: Request) => traiterCatalogueAutodiagnostic(request)
export const POST = (request: Request) => traiterCreationReferentiel(request)
