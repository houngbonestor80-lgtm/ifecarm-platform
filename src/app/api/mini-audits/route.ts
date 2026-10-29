import { traiterListeMiniAudits } from '@/mini-audit/routes'

export const GET = (request: Request) => traiterListeMiniAudits(request)
