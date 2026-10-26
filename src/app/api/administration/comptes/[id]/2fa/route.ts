import { traiterReinitialisation2fa } from '@/administration/routes'

export const POST = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterReinitialisation2fa(request, (await ctx.params).id)
