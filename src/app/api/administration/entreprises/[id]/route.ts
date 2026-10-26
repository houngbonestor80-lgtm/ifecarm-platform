import { traiterModificationEntreprise } from '@/administration/routes'

export const PATCH = async (request: Request, ctx: { params: Promise<{ id: string }> }) =>
  traiterModificationEntreprise(request, (await ctx.params).id)
