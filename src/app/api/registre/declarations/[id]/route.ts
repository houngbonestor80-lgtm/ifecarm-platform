import { traiterDetail, traiterModification } from '@/registre/routes'

export const GET = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterDetail(request, (await ctx.params).id)
export const PATCH = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterModification(request, (await ctx.params).id)
