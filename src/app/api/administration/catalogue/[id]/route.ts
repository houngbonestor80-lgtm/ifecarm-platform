import { traiterModificationCatalogue } from '@/formations/routes'

export const PATCH = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterModificationCatalogue(request, (await ctx.params).id)
