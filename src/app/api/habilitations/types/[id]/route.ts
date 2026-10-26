import { traiterModificationType } from '@/habilitations/routes'

export const PATCH = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterModificationType(request, (await ctx.params).id)
