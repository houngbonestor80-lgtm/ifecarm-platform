import { traiterModificationConsultant, traiterSuppressionConsultant } from '@/administration/routes'

export const PATCH = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterModificationConsultant(request, (await ctx.params).id)
export const DELETE = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterSuppressionConsultant(request, (await ctx.params).id)
