import { traiterModificationReferentiel, traiterReferentielAutodiagnostic, traiterSuppressionReferentiel } from '@/autodiagnostic/routes'

export const GET = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterReferentielAutodiagnostic(request, (await ctx.params).id)
export const PATCH = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterModificationReferentiel(request, (await ctx.params).id)
export const DELETE = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterSuppressionReferentiel(request, (await ctx.params).id)
