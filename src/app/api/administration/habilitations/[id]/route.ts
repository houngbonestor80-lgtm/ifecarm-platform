import { traiterModificationTypeCatalogue } from '@/habilitations/routes'

export const PATCH = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterModificationTypeCatalogue(request, (await ctx.params).id)
