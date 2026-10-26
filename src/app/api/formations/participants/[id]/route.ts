import { traiterModificationParticipant, traiterRetraitParticipant } from '@/formations/routes'

export const PATCH = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterModificationParticipant(request, (await ctx.params).id)
export const DELETE = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterRetraitParticipant(request, (await ctx.params).id)
