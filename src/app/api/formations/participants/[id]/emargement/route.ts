import { traiterEmargement } from '@/formations/routes'

export const PUT = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterEmargement(request, (await ctx.params).id)
