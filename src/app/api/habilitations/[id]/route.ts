import { traiterModificationHabilitation, traiterSuppressionHabilitation } from '@/habilitations/routes'

export const PATCH = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterModificationHabilitation(request, (await ctx.params).id)
export const DELETE = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterSuppressionHabilitation(request, (await ctx.params).id)
