import { traiterEnvoiMiniAudit, traiterQuestionnairesMiniAudit } from '@/mini-audit/routes'

export const GET = () => traiterQuestionnairesMiniAudit()
export const POST = (request: Request) => traiterEnvoiMiniAudit(request)
