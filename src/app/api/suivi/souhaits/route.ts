import { traiterLectureSouhaits, traiterModificationSouhaits } from '@/suivi/routes'

export const GET = (request: Request) => traiterLectureSouhaits(request)
export const PUT = (request: Request) => traiterModificationSouhaits(request)
