import { traiterDetailAutodiagnostic, traiterModificationAutodiagnostic, traiterSuppressionAutodiagnostic } from '@/autodiagnostic/routes'

export const GET = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterDetailAutodiagnostic(request, (await ctx.params).id)
export const PATCH = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterModificationAutodiagnostic(request, (await ctx.params).id)
export const DELETE = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterSuppressionAutodiagnostic(request, (await ctx.params).id)
