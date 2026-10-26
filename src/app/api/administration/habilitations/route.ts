import { traiterCatalogueHabilitations, traiterCreationTypeCatalogue } from '@/habilitations/routes'

export const GET = (request: Request) => traiterCatalogueHabilitations(request)
export const POST = (request: Request) => traiterCreationTypeCatalogue(request)
