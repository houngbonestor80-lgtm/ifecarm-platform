import { traiterCreationPays, traiterListePays } from '@/pays/routes'

export const GET = (request: Request) => traiterListePays(request)
export const POST = (request: Request) => traiterCreationPays(request)
