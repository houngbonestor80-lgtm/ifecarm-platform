import { traiterDetailSession, traiterModificationSession } from '@/formations/routes'

export const GET = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterDetailSession(request, (await ctx.params).id)
export const PATCH = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterModificationSession(request, (await ctx.params).id)
