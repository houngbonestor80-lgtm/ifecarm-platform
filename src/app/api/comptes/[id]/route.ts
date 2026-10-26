import { traiterModificationCompte } from '@/acces/routes'

export const PATCH = async (request: Request, ctx: { params: Promise<{ id: string }> }) =>
  traiterModificationCompte(request, (await ctx.params).id)
